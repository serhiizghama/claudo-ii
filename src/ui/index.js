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

/** `02-api-contracts.md` §14's `setScreen` signature — verbatim. */
const VALID_SCREENS = new Set(['boot', 'main_menu', 'character_create', 'game', 'death', 'reward_choice']);

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
  }

  /**
   * Drives `./hud.js`'s per-frame plinth/orb/XP-bar update. `Fixed: N` —
   * presentation only (`ARCHITECTURE.md` rule 5 / `09 §D-D`): integrates
   * `dt`, the scaled game clock, never `fixedUpdate`.
   * @param {number} dt
   * @param {object} ctx
   */
  lateUpdate(dt, ctx) {
    if (this._hud) this._hud.update(dt, ctx);
    if (this._feedback) this._feedback.update(dt, ctx);
    if (this._tooltip) this._tooltip.update(dt, ctx);
    if (this._hotbar) this._hotbar.update(dt, ctx);
    if (this._inventory) this._inventory.update(dt, ctx);
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

  /** `02-api-contracts.md:1274`: `toggleInventory() => void`. */
  toggleInventory() {
    if (this._inventory) this._inventory.toggle();
  }

  /**
   * `02-api-contracts.md` §14: `debugState(name) => void` — dev/test-only
   * staging, never called from real gameplay. Built incrementally, one
   * `mode` per ticket (`docs/PROGRESS.md` D-23): `'combat'` (this ticket,
   * `09 §15` U1) delegates to `./hud.js#debugState`; `'inventory'` (UI-7),
   * `'tree'` (UI-9, M4) and `'vendor'` (UI-12, M6) each add one more `if`
   * below, against their own module, without touching this one's branch —
   * `static deps` and every other line of this file are untouched by
   * adding a mode here.
   * @param {'combat'|'inventory'|'tree'|'vendor'|'clean'} name
   */
  debugState(name) {
    if (name === 'combat' && this._hud) this._hud.debugState('combat');
    if (name === 'inventory' && this._inventory) this._inventory.open();
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
}
