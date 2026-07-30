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
// `static deps` — why this is `['player']`, not `['items','player']`
// ---------------------------------------------------------------------------
// `02-api-contracts.md` §14 declares `static deps = ['items','player']`.
// `items` does not exist yet (M3) — nobody has ever called
// `registry.add(ItemsSystem)` — so `src/core/registry.js#resolve()` would
// throw `'ui' depends on 'items', which is not registered` the instant this
// class is registered, before any subsystem's `init()` runs: the whole boot,
// dead, for every other landed ticket too. `src/actors/index.js` (ACTR-1)
// set the exact precedent for this ("why this is ['physics'], not
// ['materials', 'physics']") and `src/player/index.js` (PLYR-1/2) did the
// same for its own contract deps — declaring only the dependency that is
// real today. Once ITMS-1 registers `items`, this line must go back to
// `['items', 'player']`.
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

/** `02-api-contracts.md` §14's `setScreen` signature — verbatim. */
const VALID_SCREENS = new Set(['boot', 'main_menu', 'character_create', 'game', 'death', 'reward_choice']);

export class UiSystem {
  static id = 'ui';
  static deps = ['player']; // 'items' omitted — not registered yet, see the file header

  constructor() {
    this._doc = null;
    this._root = null;
    this._layers = null;
    this._lang = 'en';
    this._screen = null;
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
  }

  /**
   * `02-api-contracts.md` §14: `setScreen(screenId) => void`. Records the
   * active screen; no screen has any DOM yet (U13 builds it), so this is
   * pure state today — but it is real state, which is what lets
   * `src/main.js`'s B7/B12 boot stages mark themselves `'done'` truthfully
   * once `ui` is registered.
   * @param {'boot'|'main_menu'|'character_create'|'game'|'death'|'reward_choice'} screenId
   */
  setScreen(screenId) {
    if (!VALID_SCREENS.has(screenId)) return;
    this._screen = screenId;
  }

  /** Removes every DOM node this subsystem created (`ARCHITECTURE.md` rule
   * 7). The shared `<style>` is left in place — see `style.js#removeStyle`
   * for why the module keeps that as a separate call the caller opts into;
   * a single-`UiSystem`-per-process game never needs it removed mid-run,
   * only a test harness that disposes and re-inits does, and that harness
   * can call `removeStyle()` itself. */
  dispose() {
    if (this._root) this._root.remove();
    this._root = null;
    this._layers = null;
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
