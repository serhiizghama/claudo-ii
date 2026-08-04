// src/ui/index.js
//
// UI-1 — the `ui` subsystem shell: `09 §15`'s U0 row ("Skeleton and design
// system"). Builds the `#ui` overlay (root + 8 layers, `09 §13.1`'s "root +
// 8 layers | 9"), injects the design-system stylesheet (`./style.js`), and
// implements exactly the two public methods this ticket's acceptance
// criterion names — `t()` and `setLanguage()` — plus `setScreen()`, which
// `src/main.js`'s B7/B12 already call via `ctx.peek('ui')` (see that file's
// boot sequence) and which costs nothing to support truthfully at U0 (it
// only records which screen is active; no screen has any DOM yet — U13
// builds the actual menu/creation/death chrome).
//
// Nothing else in `02-api-contracts.md` §14's method table is implemented
// here — `openInventory`, `showTooltip`, `damageNumber`, etc. all belong to
// the ticket that builds the widget they control (U1-U14), the same
// "deliberately absent, not stubbed" discipline `src/combat/packet.js`'s
// header already established for its own contract table. Adding them now,
// with nothing behind them, would be exactly the kind of premature public
// surface rule 7 (`docs/spec/02-api-contracts.md` is the only source of
// truth for a public method) warns against.
//
// ---------------------------------------------------------------------------
// `static deps` — O-61: restored to `['items','player']`
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §14 declares `static deps = ['items','player']`.
// This used to read `['player']` only, because `items` did not exist yet
// (M3) — nobody had ever called `registry.add(ItemsSystem)`, so
// `src/core/registry.js#resolve()` would have thrown `'ui' depends on
// 'items', which is not registered` before any subsystem's `init()` ran.
// `items` has been registered since ITEM-1 (`src/main.js` now calls
// `registry.add(ItemsSystem)`), and this ticket (UI-3) is the first one that
// genuinely needs `ctx.get('items')` — `./hotbar.js`'s belt sweep reads
// `items.beltCooldown(actor)` — so the omission's own reason is gone and
// this line is restored. `resolve()`'s topological sort is keyed on
// `static deps`, not on `registry.add()` call order (`src/main.js` still
// registers `ui` before `items`, at lines ~449-450) — so `items` now
// initializes before `ui` regardless, and `tests/core/boot.test.js` (which
// exercises exactly this DFS) stays green. See this ticket's report for the
// one test this flips: `tests/ui/ui1.test.js` still asserts the literal
// `['player']` array and was not in this ticket's file grant to fix.
//
// ---------------------------------------------------------------------------
// Why no `fixedUpdate`, and no real `update`/`lateUpdate` yet
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 5 / this ticket's brief: `ui` must never implement
// `fixedUpdate` at all — it is presentation, never simulation. `update`/
// `lateUpdate` are where `09`'s D-D two-clock integration eventually lives
// (`rawDt` for interface motion, `dt` for game-clock motion), but nothing
// draws at U0 (`09 §15`'s U0 row: "Nothing draws yet"), so there is nothing
// for either hook to do yet — both are left unimplemented (the engine skips
// a missing hook, `src/core/engine.js#frame()`) rather than shipped as an
// empty function that would just be deleted the moment U1 needs the real
// one.

import { resolveDocument, countNodes } from './util.js';
import { injectStyle, LAYER_NAMES } from './style.js';
import { EN, RU, format, missingRuKeys } from './i18n.js';
import { Hud } from './hud.js';
import { Feedback } from './feedback.js';
import { Tooltip } from './tooltip.js';
import { Hotbar } from './hotbar.js';
import { Inventory } from './inventory.js';
import { Sheet } from './sheet.js';
import { Target } from './target.js';
import { Tree } from './tree.js';
import { Minimap } from './minimap.js';

/** `02-api-contracts.md` §14's `setScreen` signature — verbatim. */
const VALID_SCREENS = new Set(['boot', 'main_menu', 'character_create', 'game', 'death', 'reward_choice']);

/** Defensive `ctx.get`/`ctx.peek` — duplicated per-module precedent
 * (`inventory.js`/`hotbar.js`/`sheet.js` each carry their own copy); used
 * here only by the O-78 pointer guard's `ctx.get('render')` lookup, which
 * must never throw against a bare test ctx. */
function safeGet(ctx, id) {
  if (!ctx) return null;
  if (typeof ctx.peek === 'function') return ctx.peek(id) || null;
  if (typeof ctx.has === 'function' && typeof ctx.get === 'function') return ctx.has(id) ? ctx.get(id) : null;
  if (typeof ctx.get === 'function') {
    try { return ctx.get(id); } catch { return null; }
  }
  return null;
}

export class UiSystem {
  static id = 'ui';
  static deps = ['items', 'player']; // O-61 — restored, see the file header

  constructor() {
    this._doc = null;
    this._root = null;
    this._layers = null;
    this._lang = 'en';
    this._screen = null;
    this._hud = null; // UI-2's plinth/orbs/XP module (./hud.js), built in init()
    this._feedback = null; // UI-4's damage numbers/flash/vignette module (./feedback.js), built in init()
    this._tooltip = null; // UI-5's item tooltip (./tooltip.js), built in init()
    this._hotbar = null; // UI-3's hotbar/belt/prompt/toast/banner module (./hotbar.js), built in init()
    this._inventory = null; // UI-6's inventory panel/drag-drop module (./inventory.js), built in init()
    this._sheet = null; // UI-10's character sheet + paperdoll module (./sheet.js), built in init()
    this._target = null; // UI-8's target bar + buff strip module (./target.js), built in init()
    this._tree = null; // UI-9's skill tree module (./tree.js), built in init()
    this._minimap = null; // UI-11's minimap + ground-label module (./minimap.js), built in init()

    // ---------------------------------------------------------------
    // O-78, the `ui` half of `pointerOverUi` (`09` §11.4) — UI-10 is the
    // first ticket that needs it (a panel that finally has real click
    // targets — equipment slots — inside a game screen the world's own
    // click-to-move also listens on). See `init()`'s
    // `_installPointerGuard` and the `pointerOverUi` getter below for the
    // full mechanism.
    // ---------------------------------------------------------------
    this._pointerOverUiLive = false;
    this._swallowUntilFrame = -1;
    this._localFrameCounter = 0;
    this._pointerGuardHandler = null;
  }

  /**
   * Builds the `#ui` overlay skeleton (root + 8 empty layer panes) and
   * injects the design-system stylesheet. Allocates DOM nodes exactly once
   * — never per frame, never again after this call (`ARCHITECTURE.md` rule
   * 6/7: build in `init()`, dispose in `dispose()`).
   * @param {object} ctx
   */
  async init(ctx) {
    this._ctx = ctx;
    this._doc = resolveDocument();

    injectStyle(this._doc);

    const root = this._doc.createElement('div');
    root.className = 'cl2-ui';
    root.id = 'ui';

    const layers = {};
    for (let i = 0; i < LAYER_NAMES.length; i++) {
      const name = LAYER_NAMES[i];
      const layer = this._doc.createElement('div');
      layer.className = 'cl2-layer';
      layer.setAttribute('data-cl2-layer', name);
      root.appendChild(layer);
      layers[name] = layer;
    }

    const host = this._doc.body || this._doc.head;
    if (host) host.appendChild(root);

    this._root = root;
    this._layers = layers;

    // `09 §14.1`'s boot-time dev check — run once, here, never per frame.
    // Every key this ticket's EN carries also has an RU entry (see
    // `i18n.js`), so this is expected to print nothing; kept as a live
    // guard for whichever U1+ ticket adds an EN key and forgets the RU one.
    const missing = missingRuKeys();
    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[ui] RU dictionary missing ${missing.length} key(s): ${missing.join(', ')}`);
    }

    // The ONE `ui`-subsystem RNG fork (ARCHITECTURE.md's Determinism
    // contract: "One ctx.rng.fork() per subsystem, taken once in
    // init()") — taken here, at the subsystem boundary, and handed to
    // every internal module that needs jitter, rather than each module
    // forking `ctx.rng` for itself. UI-4 found the failure mode live: a
    // second independent fork inside `feedback.js` shifted `items`' own
    // later fork and moved `ui_clean` by 241081 px. `typeof
    // ctx.rng.fork === 'function'` guards the bare-ctx Node harness
    // (`tests/ui/ui1.test.js`'s own `init({})` calls) the same way
    // `hud.js`'s old self-fork used to.
    const rng = ctx && ctx.rng && typeof ctx.rng.fork === 'function' ? ctx.rng.fork() : null;

    // UI-2 (09 §15 U1) — the plinth, orbs and XP bar. Attached into the
    // `hud` layer (./style.js#LAYER_NAMES, 09 §3.4's z30 chrome layer), the
    // one instantiation this ticket is granted on this file (see hud.js's
    // own header for everything it builds/owns). `this.t.bind(this)` is
    // passed rather than duplicating ./i18n.js's lookup logic in hud.js.
    this._hud = new Hud(ctx, layers.hud, (key, params) => this.t(key, params), rng);

    // UI-4 (09 §15 U3) — damage numbers, the hit flash, the screenImpulse
    // wiring and the low-life vignette. Attached into the `feedback` layer
    // (./style.js#LAYER_NAMES) this ticket owns — see feedback.js's own
    // header for why the whole feature lands on this one layer rather than
    // the detailed z10/z25 split 09 §3.4 describes. Shares the same `rng`
    // fork as `Hud` above — see this method's own comment just above.
    this._feedback = new Feedback(ctx, layers.feedback, (key, params) => this.t(key, params), rng);

    // UI-5 (09 §15 U5) — the item tooltip. Attached into the `tooltip`
    // layer (./style.js#LAYER_NAMES, z-index 4 — above panels, below
    // feedback), the one layer this ticket owns. Shares the same `rng`
    // fork as `Hud`/`Feedback` above for the same one-fork-per-subsystem
    // reason (unused by this module today — see tooltip.js's own header).
    this._tooltip = new Tooltip(ctx, layers.tooltip, (key, params) => this.t(key, params), rng);

    // UI-3 (09 §15 U2) — hotbar, belt, prompt, toast, banner. Hotbar/belt
    // attach into `hud` (this ticket's own instruction); prompt/toast/banner
    // into `feedback`, alongside `Feedback`'s own subtree — see hotbar.js's
    // own header for why. Shares the same `rng` fork for the same
    // one-fork-per-subsystem reason (unused today — see hotbar.js's header).
    this._hotbar = new Hotbar(ctx, layers.hud, layers.feedback, (key, params) => this.t(key, params), rng);

    // UI-6 (09 §15 U7) — the inventory panel and drag/drop. Attached into
    // `panels` (chrome/grid/belt-mirror/split-chip) and `cursor` (the drag
    // ghost, `09 §6.3`: "the drag ghost is created at layer 60") — both
    // layers this ticket owns per its own file grant. `this.toast(...)` is
    // passed the same way `translate` is — `hotbar.js` (UI-3, closed) owns
    // the toast column; `inventory.js` reaches it through this one bound
    // callback rather than reopening that file.
    this._inventory = new Inventory(ctx, layers.panels, layers.cursor, (key, params) => this.t(key, params), rng, (text, kind) => this.toast(text, kind));

    // UI-10 (09 §15 U8) — the character sheet, its ten equipment slots and
    // the uiScene paperdoll. Attached into `panels` — this ticket's own
    // file-grant instruction ("attach into layers.panels. Do not
    // restructure the layer stack"), the same layer `Inventory` above
    // already uses (the left/right zones, 09 §3.3, never collide).
    this._sheet = new Sheet(ctx, layers.panels, (key, params) => this.t(key, params), rng, (text, kind) => this.toast(text, kind));

    // UI-8 (09 §15 U4) — the target health bar (all four rank layouts,
    // ghost, segment ticks, affix chips, immunity marks, boss phase ticks)
    // and the 24-entry buff/debuff strip. Attached into `layers.hud` — this
    // ticket's own file-grant instruction, the same persistent-HUD-chrome
    // layer `Hud`/`Hotbar` above already occupy (UI-9/UI-10 use
    // `layers.panels` instead, see target.js's own header). Shares the same
    // `rng` fork for the same one-fork-per-subsystem reason (unused today —
    // see target.js's own header).
    this._target = new Target(ctx, layers.hud, (key, params) => this.t(key, params), rng);

    // UI-9 (09 §15 U10) — the skill tree screen: the node lattice, the
    // connector canvas, the detail card, provisional allocation/confirm/
    // revert and the close-with-pending dialog. Attached into `layers.panels`
    // — this ticket's own file-grant instruction, the same layer
    // `Inventory`/`Sheet` above already occupy. Shares the same `rng` fork
    // for the same one-fork-per-subsystem reason (unused today — see
    // tree.js's own header).
    this._tree = new Tree(ctx, layers.panels, (key, params) => this.t(key, params), rng, (text, kind) => this.toast(text, kind));

    // UI-11 (09 §15 U11) — the corner minimap, the `Tab` overlay and the
    // ground-item labels. Attached into `layers.hud`, the same persistent-HUD
    // band `Hud`/`Hotbar`/`Target` already occupy. `09 §3.4` puts the labels
    // on their own z20 world band, which this codebase's 8-layer stack
    // (./style.js#LAYER_NAMES) does not have; they go on `hud` with the
    // minimap rather than restructuring a layer stack eight accepted modules
    // sit on — recorded in this ticket's report. The fifth argument is O-78's
    // swallow hook: a ground label is the only world-anchored clickable in
    // the whole overlay, and `09 §9.5` requires its click to never also be a
    // move order (see minimap.js#_onLabelPointerDown for why
    // `stopPropagation()` alone does not achieve that against `player`'s
    // latched input snapshot).
    this._minimap = new Minimap(ctx, layers.hud, (key, params) => this.t(key, params), rng, () => this._armPointerSwallow(ctx));

    // O-78 — the `ui` half of `pointerOverUi` (09 §11.4). Installed once
    // here, after every panel module above has had a chance to build its
    // own DOM (not that installation order matters — this only reads
    // `event.target`/`this._root` at dispatch time, never at install time).
    this._installPointerGuard(ctx);
  }

  /**
   * Drives `./hud.js`'s per-frame plinth/orb/XP-bar update. `Fixed: N` —
   * presentation only (`ARCHITECTURE.md` rule 5 / `09 §D-D`): integrates
   * `dt`, the scaled game clock, never `fixedUpdate`.
   * @param {number} dt
   * @param {object} ctx
   */
  lateUpdate(dt, ctx) {
    // O-78's swallow-guard clock — see `pointerOverUi`'s getter below.
    // Incremented unconditionally, every real engine frame, so the guard
    // has a monotonic "frame" to hold against even under a bare test ctx
    // with no `render` subsystem (the fallback `_currentFrame()` uses this
    // instead of `render.frameIndex` when `render` is absent).
    this._localFrameCounter++;
    if (this._hud) this._hud.update(dt, ctx);
    if (this._feedback) this._feedback.update(dt, ctx);
    if (this._tooltip) this._tooltip.update(dt, ctx);
    if (this._hotbar) this._hotbar.update(dt, ctx);
    if (this._inventory) this._inventory.update(dt, ctx);
    if (this._sheet) this._sheet.update(dt, ctx);
    if (this._target) this._target.update(dt, ctx);
    if (this._tree) this._tree.update(dt, ctx);
    // UI-11 — last of the group: the ground labels project against the same
    // camera the world was drawn with this frame. `09 §4.7`'s "hidden while a
    // `left`-zone panel is open" is arbitrated here, not inside the module,
    // because `ui` is the one owner of panel state — and the only `left`
    // panel that exists today (`09 §3.3`'s table also lists stash, vendor and
    // the quest log, all UI-12) is the character sheet.
    if (this._minimap) {
      this._minimap.setCornerSuppressed(!!(this._sheet && this._sheet.isOpen()));
      this._minimap.update(dt, ctx);
    }
  }

  /**
   * `02-api-contracts.md` §14: `t(key, params) => string`. Looks `key` up
   * in the active dictionary, falls back to `EN`, falls back again to
   * `[missing]<key>`. Never throws (`09 §14.1`).
   * @param {string} key
   * @param {object} [params]
   * @returns {string}
   */
  t(key, params) {
    const dict = this._lang === 'ru' ? RU : EN;
    let str = dict[key];
    if (str === undefined) str = EN[key];
    if (str === undefined) return `[missing]${key}`;
    return format(str, params);
  }

  /**
   * `02-api-contracts.md` §14: `setLanguage(lang) => void`. Anything other
   * than `'ru'` resolves to `'en'` — never throws on a bad value.
   * @param {'en'|'ru'} lang
   */
  setLanguage(lang) {
    this._lang = lang === 'ru' ? 'ru' : 'en';
    // UI-5: a rare's rolled name carries both `{en,ru}` (ITEM-8) with no
    // active-language parameter on `items` — `ui` is the one place that
    // knows which language is active, so an already-open tooltip must
    // switch its displayed name live, the same way `setAltHeld` already
    // forces a live content rebuild.
    if (this._tooltip) this._tooltip.setLanguage(this._lang);
    // UI-11: the same live-switch reason — a ground label carries a rolled
    // item name, and the zone name under the minimap is a dictionary lookup.
    if (this._minimap) this._minimap.setLanguage(this._lang);
  }

  /**
   * `02-api-contracts.md` §14: `setScreen(screenId) => void`. Records the
   * active screen; no screen has any DOM yet (U13 builds it) beyond UI-2's
   * own HUD, which this method gates on it — `09-ui.md:2128` states the
   * same principle for the low-life vignette ("suppressed entirely while
   * the death screen or the main menu is up"); the plinth/orbs/XP bar must
   * not draw, or spend per-frame work, over `main_menu`/`character_create`/
   * `death`/`boot`/`reward_choice` either. `src/main.js`'s B7/B12 boot
   * stages mark themselves `'done'` truthfully once `ui` is registered.
   * @param {'boot'|'main_menu'|'character_create'|'game'|'death'|'reward_choice'} screenId
   */
  setScreen(screenId) {
    if (!VALID_SCREENS.has(screenId)) return;
    this._screen = screenId;
    if (this._hud) this._hud.setVisible(screenId === 'game');
    // UI-4: `09-ui.md:2128`'s own gating principle ("the vignette is
    // suppressed entirely while the death screen or the main menu is
    // up"), generalised the same way UI-2 generalised it for the plinth —
    // damage numbers/flash/vignette must not draw, or spend per-frame
    // work, over any non-`game` screen either.
    if (this._feedback) this._feedback.setVisible(screenId === 'game');
    // UI-5: a tooltip left open across a screen change (e.g. opening the
    // main menu while hovering an item) would draw over chrome it has no
    // business being on top of — same gating principle as the two lines
    // above, generalised once more.
    if (this._tooltip && screenId !== 'game') this._tooltip.hideTooltip();
    // UI-3: the hotbar/belt/prompt/toast/banner group is exactly the same
    // "chrome, not a modal" class as the plinth — same gating principle.
    if (this._hotbar) this._hotbar.setVisible(screenId === 'game');
    // UI-6: a panel left open across a screen change (e.g. opening the main
    // menu while the inventory is up) must not keep drawing, or leave a
    // drag mid-flight, over chrome it has no business being on top of —
    // same gating principle as the lines above. `Inventory#close()` also
    // cancels any in-progress drag (`items.returnCursor()`), so nothing is
    // left orphaned on the cursor across the screen change.
    if (this._inventory && screenId !== 'game') this._inventory.close();
    // UI-10: same gating principle — the character sheet (and its uiScene
    // paperdoll, hidden via `Sheet#close()`) must not keep drawing over a
    // non-`game` screen either.
    if (this._sheet && screenId !== 'game') this._sheet.close();
    // UI-8: the target bar/buff strip is the same "persistent HUD chrome,
    // not a modal" class as the plinth/hotbar — same gating principle.
    if (this._target) this._target.setVisible(screenId === 'game');
    // UI-9: same gating principle — a screen change force-closes the tree
    // panel (`close(true)`, bypassing the close-with-pending dialog: this
    // is teardown, not a user asking to leave with unconfirmed points).
    if (this._tree && screenId !== 'game') this._tree.close(true);
    // UI-11: the minimap is the same "persistent HUD chrome" class as the
    // plinth. Leaving `game` also closes the `Tab` overlay — it draws over
    // the world, and there is no world under a menu.
    if (this._minimap) {
      this._minimap.setVisible(screenId === 'game');
      if (screenId !== 'game') this._minimap.setMinimapOpen(false);
    }
  }

  /** Removes every DOM node this subsystem created (`ARCHITECTURE.md` rule
   * 7). The shared `<style>` is left in place — see `style.js#removeStyle`
   * for why the module keeps that as a separate call the caller opts into;
   * a single-`UiSystem`-per-process game never needs it removed mid-run,
   * only a test harness that disposes and re-inits does, and that harness
   * can call `removeStyle()` itself. */
  dispose() {
    if (this._hud) this._hud.dispose();
    this._hud = null;
    if (this._feedback) this._feedback.dispose();
    this._feedback = null;
    if (this._tooltip) this._tooltip.dispose();
    this._tooltip = null;
    if (this._hotbar) this._hotbar.dispose();
    this._hotbar = null;
    if (this._inventory) this._inventory.dispose();
    this._inventory = null;
    if (this._sheet) this._sheet.dispose();
    this._sheet = null;
    if (this._target) this._target.dispose();
    this._target = null;
    if (this._tree) this._tree.dispose();
    this._tree = null;
    if (this._minimap) this._minimap.dispose();
    this._minimap = null;
    this._removePointerGuard();
    if (this._root) this._root.remove();
    this._root = null;
    this._layers = null;
  }

  /**
   * `02-api-contracts.md:1280`: `showTooltip(item, screenX, screenY,
   * compare) => void`. UI-5 (`09 §5`) — delegates to `./tooltip.js`.
   * `compare` is accepted and stored, never acted on: comparison mode
   * (`09 §5.6`, `§15` U9) is UI-7, a separate ticket reopening this same
   * file.
   */
  showTooltip(item, screenX, screenY, compare) {
    if (this._tooltip) this._tooltip.showTooltip(item, screenX, screenY, compare);
  }

  /** `02-api-contracts.md:1281`: `hideTooltip() => void`. */
  hideTooltip() {
    if (this._tooltip) this._tooltip.hideTooltip();
  }

  /**
   * `02-api-contracts.md:1283`: `setAltHeld(on) => void` — Alt drives both
   * the loot labels (`setLootLabels`, a different ticket) and the tooltip
   * roll-range reveal (`09 §5.3.2`), live, on an already-open tooltip.
   */
  setAltHeld(on) {
    if (this._tooltip) this._tooltip.setAltHeld(on);
    // UI-11 — the other half the contract row names: `09 §9.2` rule 3, "Alt
    // is held → show every ground-item label".
    if (this._minimap) this._minimap.setAltHeld(on);
  }

  /**
   * `02-api-contracts.md:1289`: `setLootLabels(on) => void` — `09 §9.2` rule
   * 4, `SettingsSave.alwaysShowLoot`. Unimplemented until UI-11 because there
   * were no labels to show.
   */
  setLootLabels(on) {
    if (this._minimap) this._minimap.setLootLabels(on);
  }

  /**
   * `02-api-contracts.md:1301`: `setMinimapOpen(on) => void` — `09 §4.7`'s
   * overlay mode, `09 §11.2`'s `Tab` (`toggle_map`). `ui` may not read
   * `ctx.input` (`09 §16.1`), so `player` owns the key and calls this.
   */
  setMinimapOpen(on) {
    if (this._minimap) this._minimap.setMinimapOpen(on);
  }

  /** @returns {boolean} whether the `Tab` overlay is up. */
  isMinimapOpen() {
    return this._minimap ? this._minimap.isMinimapOpen() : false;
  }

  /**
   * `09 §11.2`'s `M` (`toggle_minimap`) — the corner map on/off. UI-11's own
   * new row, the same shape `toggleCharacterSheet`/`toggleSkillTree` took:
   * `02-api-contracts.md` §14 has `setMinimapOpen` for `Tab` but no row for
   * `M`, and `ui` may not discover the key itself. Flagged in this ticket's
   * report alongside the other missing rows.
   */
  toggleMinimap() {
    if (this._minimap) this._minimap.toggleCorner();
  }

  /** `02-api-contracts.md:1302`: `minimapMarker(id, x, z, kind) => void`. */
  minimapMarker(id, x, z, kind) {
    if (this._minimap) this._minimap.minimapMarker(id, x, z, kind);
  }

  /** `02-api-contracts.md:1303`: `clearMinimapMarker(id) => void`. */
  clearMinimapMarker(id) {
    if (this._minimap) this._minimap.clearMinimapMarker(id);
  }

  /** O-78's swallow window, armed by something other than the guard's own
   * captured `pointerdown`. `./minimap.js`'s ground labels need it: `player`
   * suppresses a new order only through `pointerOverUi`, and it reads a
   * latched input snapshot rather than the DOM event (`09 §9.5`). */
  _armPointerSwallow(ctx) {
    this._swallowUntilFrame = this._currentFrame(ctx || this._ctx) + 2;
  }

  /**
   * `02-api-contracts.md:1284`: `setCompareHeld(on) => void`. UI-7
   * (`09 §5.6`) — Ctrl pressed/released while a tooltip is already open
   * must switch comparison mode live; `showTooltip`'s own `compare`
   * argument is fixed at open time, this is the other half.
   */
  setCompareHeld(on) {
    if (this._tooltip) this._tooltip.setCompareHeld(on);
  }

  /**
   * `02-api-contracts.md:1277`: `setTargetBar(actor:Actor|null) => void`.
   * UI-8 (`09 §15` U4, `09 §4.5`) — delegates to `./target.js`. `player`
   * (not yet wired) is this method's real caller; the 1.2 s
   * clear-after-death/leave delay named in `09 §4.5` is `player`'s own job,
   * not this method's — see `target.js#setTargetBar`'s own header.
   * @param {object|null} actor
   */
  setTargetBar(actor) {
    if (this._target) this._target.setTargetBar(actor);
  }

  /**
   * `02-api-contracts.md` §14: `damageNumber(x,y,z,amount,kind,element) =>
   * void`. UI-4 (`09 §15` U3) — delegates to `./feedback.js`'s pooled
   * `DamageNumber` machinery; see that file's own header for why this
   * signature (no target identity) bypasses coalescing/the per-target cap.
   */
  damageNumber(x, y, z, amount, kind, element) {
    if (this._feedback) this._feedback.damageNumber(x, y, z, amount, kind, element);
  }

  /**
   * `02-api-contracts.md` §14: `floatingText(x,y,z,text,colour) => void`.
   * UI-4 — same pool as `damageNumber`, `09 §10.1`'s last paragraph
   * (life 1.4s, size 15px, no pop).
   */
  floatingText(x, y, z, text, colour) {
    if (this._feedback) this._feedback.floatingText(x, y, z, text, colour);
  }

  /**
   * `02-api-contracts.md` §14: `setPrompt(spec) => void`. UI-3 (`09 §15` U2)
   * — delegates to `./hotbar.js`'s prompt widget (`09 §4.10`).
   * @param {{key:string, text:string, sub:string}|null} spec
   */
  setPrompt(spec) {
    if (this._hotbar) this._hotbar.setPrompt(spec);
  }

  /**
   * `02-api-contracts.md` §14: `toast(text, kind) => void`. UI-3 — the
   * 5-row pooled toast column (`09 §4.10`).
   * @param {string} text
   * @param {'info'|'warn'|'loot'} kind
   */
  toast(text, kind) {
    if (this._hotbar) this._hotbar.toast(text, kind);
  }

  /**
   * `02-api-contracts.md` §14: `banner(title, subtitle, seconds) => void`.
   * UI-3 — `09 §2.6`'s banner-in/out motion.
   * @param {string} title
   * @param {string} subtitle
   * @param {number} seconds
   */
  banner(title, subtitle, seconds) {
    if (this._hotbar) this._hotbar.banner(title, subtitle, seconds);
  }

  /** `02-api-contracts.md:1274`: `openInventory() => void`. UI-6 —
   * delegates to `./inventory.js`. */
  openInventory() {
    if (this._inventory) this._inventory.open();
  }

  /** `02-api-contracts.md:1274`: `closeInventory() => void`. */
  closeInventory() {
    if (this._inventory) this._inventory.close();
  }

  /**
   * `02-api-contracts.md:1274`: `toggleInventory() => void`. `09 §11.2`'s
   * `I` binding (`toggle_inventory`) is documented as opening "the
   * character sheet AND the inventory as a pair" — that pairing is this
   * method's own effect (not something `player`, which is out of this
   * ticket's file grant and has no `I`/`C` key wiring landed yet, does by
   * calling two separate `ui` methods): after toggling the inventory panel,
   * the sheet is snapped to match its new open/closed state. `C`
   * (`toggleCharacterSheet`, below) stays completely independent — pressing
   * it after `I` closes only the sheet, matching "C opens the sheet alone"
   * — and a later `I` still re-syncs the sheet to the inventory's own
   * state, so the pair never gets stuck out of step.
   */
  toggleInventory() {
    if (this._inventory) this._inventory.toggle();
    if (this._sheet) this._sheet.setVisible(this._inventory ? this._inventory.isOpen() : false);
  }

  /**
   * `02-api-contracts.md` §14: `toggleCharacterSheet() => void` — UI-10's
   * own new row (this ticket). `09 §11.2`'s `C` binding
   * (`toggle_character`): "character sheet only" — toggles the sheet in
   * isolation, never touching the inventory panel's own state (contrast
   * `toggleInventory` above, which pairs them).
   */
  toggleCharacterSheet() {
    if (this._sheet) this._sheet.toggle();
  }

  /** `02-api-contracts.md:1282`: `openSkillTree() => void`. UI-9 —
   * delegates to `./tree.js`. */
  openSkillTree() {
    if (this._tree) this._tree.open();
  }

  /** `02-api-contracts.md:1282`: `closeSkillTree() => void`. */
  closeSkillTree() {
    if (this._tree) this._tree.close();
  }

  /** `02-api-contracts.md` §14: `toggleSkillTree() => void` — UI-9's own
   * new row (this ticket). `09 §11.2`'s skill-tree binding toggles the
   * panel in isolation, the same shape `toggleCharacterSheet` above uses. */
  toggleSkillTree() {
    if (this._tree) this._tree.toggle();
  }

  /**
   * `02-api-contracts.md` §14: `debugState(name) => void` — dev/test-only
   * staging, never called from real gameplay. Built incrementally, one
   * `mode` per ticket (`docs/PROGRESS.md` D-23): `'combat'` (UI-2,
   * `09 §15` U1) delegates to `./hud.js#debugState`; `'inventory'` (UI-7)
   * opens the inventory panel; `'character'` (this ticket, UI-10) opens the
   * character sheet — `'tree'` (UI-9, M4) and `'vendor'` (UI-12, M6) still
   * add their own `if` below, against their own module, without touching
   * this one's branch. NOTE: `02-api-contracts.md`'s own `debugState` row
   * types `name` as `'combat'|'inventory'|'tree'|'vendor'|'clean'` and does
   * not list `'character'` — that table cell needs a maintainer edit this
   * ticket cannot make (rule 7: "Do not edit `02-api-contracts.md`");
   * flagged in this ticket's report. `debugState` never validates/throws on
   * an unlisted value (every branch here is a silent no-op otherwise), so
   * accepting one more string is not a contract violation today, only a
   * documentation gap upstream.
   *
   * UI-8 (this ticket) adds five more: `'target_normal'`/`'target_minion'`/
   * `'target_champion'`/`'target_unique'`/`'target_boss'` stage the target
   * bar at each of `09 §4.5`'s four rank layouts via
   * `./target.js#__debugStageRank` — D-41's hand-built-record path, since
   * `ai.debugStage('champion')`/`('boss')` (the acceptance text's own
   * literal wording) is unimplemented (`src/ai/index.js:16`) and champion/
   * boss rank promotion is AI-8 (M6). Also not in `02-api-contracts.md`'s
   * `debugState` row — same documentation gap as `'character'` above,
   * flagged in this ticket's report alongside it.
   * @param {'combat'|'inventory'|'tree'|'vendor'|'clean'|'character'|'target_normal'|'target_minion'|'target_champion'|'target_unique'|'target_boss'} name
   */
  debugState(name) {
    if (name === 'combat' && this._hud) this._hud.debugState('combat');
    if (name === 'inventory' && this._inventory) this._inventory.open();
    if (name === 'character' && this._sheet) this._sheet.open();
    // UI-9 (this ticket) — 'tree' is already in `02-api-contracts.md`'s own
    // `debugState` type union (see this method's own doc comment above);
    // no doc gap to report for this one, unlike 'character'/'target_*'.
    if (name === 'tree' && this._tree) this._tree.open();
    if (typeof name === 'string' && name.indexOf('target_') === 0 && this._target) {
      this._target.__debugStageRank(name.slice('target_'.length));
    }
  }

  // -------------------------------------------------------------------
  // O-78 — the `ui` half of `pointerOverUi` (`09` §11.4). `player` (a
  // different, not-yet-landed ticket's file) is the only reader
  // (`fixedUpdate`, before honouring a latched click); this subsystem is
  // only the writer.
  // -------------------------------------------------------------------

  /**
   * Installs ONE `document`-level `pointerdown`/`pointermove` listener in
   * the CAPTURE phase (`09` §11.4 point 2, verbatim: `pointerOverUi =
   * eventTarget is a Node && uiRoot.contains(eventTarget) &&
   * eventTarget.closest('[data-ui-solid]') !== null`) — no
   * `elementFromPoint`, no `getBoundingClientRect`, `event.target` is
   * already the hit result. Defensive against the Node DOM shim
   * (`./util.js`'s `resolveDocument`), which implements neither
   * `addEventListener` nor `Element#closest` — the same "degrade
   * gracefully under Node" discipline every other `ui` module's own event
   * binding already follows (`inventory.js#_bindEvents`).
   */
  _installPointerGuard(ctx) {
    const doc = this._doc;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    const handler = (e) => this._onGuardPointerEvent(e, ctx);
    doc.addEventListener('pointerdown', handler, true);
    doc.addEventListener('pointermove', handler, true);
    this._pointerGuardHandler = handler;
    this._pointerGuardDoc = doc;
  }

  _removePointerGuard() {
    if (this._pointerGuardHandler && this._pointerGuardDoc && typeof this._pointerGuardDoc.removeEventListener === 'function') {
      this._pointerGuardDoc.removeEventListener('pointerdown', this._pointerGuardHandler, true);
      this._pointerGuardDoc.removeEventListener('pointermove', this._pointerGuardHandler, true);
    }
    this._pointerGuardHandler = null;
    this._pointerGuardDoc = null;
  }

  _onGuardPointerEvent(e, ctx) {
    const target = e && e.target;
    const solid = !!(target
      && this._root
      && typeof this._root.contains === 'function'
      && this._root.contains(target)
      && typeof target.closest === 'function'
      && target.closest('[data-ui-solid]') !== null);
    this._pointerOverUiLive = solid;
    // `09` §11.4 point 4, "the close-click guard": ANY solid pointerdown
    // (which includes a close button — it lives inside the panel, which
    // itself carries `data-ui-solid`, `09` point 1's "panels and everything
    // inside them") arms one extra frame of `pointerOverUi = true` beyond
    // the click itself. This is what stops the classic bug the spec names:
    // dismissing a panel walks the character into the pointer's position,
    // because the SAME pointerdown that closed the panel would otherwise
    // resolve `pointerOverUi = false` one frame later once the panel's gone.
    if (solid && e && e.type === 'pointerdown') {
      this._swallowUntilFrame = this._currentFrame(ctx) + 2;
    }
  }

  _currentFrame(ctx) {
    const render = safeGet(ctx || this._ctx, 'render');
    if (render && typeof render.frameIndex === 'number') return render.frameIndex;
    return this._localFrameCounter;
  }

  /** `02-api-contracts.md` §14: `pointerOverUi` property → `boolean`,
   * `Fixed: Y` — `player.fixedUpdate` reads this before honouring a
   * latched click (`11-flows.md` §3.2, rule 1). Live hit-test OR the
   * 2-frame close-click hold, whichever is true. */
  get pointerOverUi() {
    if (this._pointerOverUiLive) return true;
    return this._currentFrame(this._ctx) < this._swallowUntilFrame;
  }

  // -------------------------------------------------------------------
  // Dev-only escape hatches — not in `02-api-contracts.md`, so not public
  // API (rule 7); double-underscore, matching `src/actors/index.js`'s
  // `__archetypeVisuals` convention for this codebase's dev-only surface.
  // -------------------------------------------------------------------

  /** @returns {number} the live count of `#ui` plus every descendant —
   * `09 §13.1`'s dev-build node-count assert, at U0 scope (a full
   * once-per-second throw-above-cap instrumentation is U14's job; this is
   * the read the acceptance criterion needs today). */
  __nodeCount() {
    return this._root ? countNodes(this._root) : 0;
  }

  /** Test/dev-only: drives the exact `pointerOverUi` guard code path
   * (`_onGuardPointerEvent`) a real captured `pointerdown`/`pointermove`
   * would, without a real DOM listener — the Node shim (`./util.js`)
   * implements neither `addEventListener` nor `Element#closest`, so the
   * real listener installed by `_installPointerGuard` never fires under
   * `node --test`. Same "no real DOM under Node" problem
   * `inventory.js`'s own `__simulatePointerDown`/`__simulatePointerMove`
   * solve for that module; this is the same tier for O-78's guard.
   * @param {'pointerdown'|'pointermove'} type
   * @param {object|null} target - a node (real or Node-shim) to hit-test.
   */
  __simulatePointerGuardEvent(type, target) {
    this._onGuardPointerEvent({ type, target }, this._ctx);
  }
}
