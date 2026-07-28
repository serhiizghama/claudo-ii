// src/core/input.js
//
// CORE-7 — input latching.
//
// Scope (see docs/ARCHITECTURE.md and docs/spec/11-flows.md §2, §3.1, §12.3):
// this module owns the only DOM listeners for pointer/keyboard input and
// turns them into a per-frame snapshot. `src/core/engine.js` (CORE-2, not
// this ticket) already calls `ctx.input.beginFrame()` at the top of
// `Engine.frame()` and `ctx.input.endFrame()` at the bottom — those two names
// are load-bearing and are not renamed here. `attach()`/`detach()` are called
// once at boot (11-flows.md B6) and on shutdown.
//
// The construction that makes "fixedUpdate cannot read input" true by
// construction, not by convention:
//
//   - DOM events (`_onKeyDown`, `_onPointerMove`, ...) only ever write into a
//     private raw buffer (`_keyEntries[i].live/downEdge/upEdge`, the button
//     equivalents, `_rawPointerX/Y`, `_rawWheelDeltaY`). Nothing outside this
//     file can reach that buffer — it is not exposed on `this` under any
//     public name.
//   - `beginFrame()` is the *only* place that ever writes the public snapshot
//     fields (`held`/`pressed`/`released` on each key/button entry,
//     `this.pointer.x/y`, `this.wheelDeltaY`). It drains the raw buffer once,
//     latching whatever accumulated since the previous `beginFrame()`.
//   - `endFrame()` only clears the one-shot `pressed`/`released` flags it
//     already latched; it never reads the raw buffer.
//   - The public accessors (`keyHeld`, `keyPressed`, `keyReleased`,
//     `buttonHeld`, `buttonPressed`, `buttonReleased`, `pointer`,
//     `wheelDeltaY`) only ever read the snapshot fields — there is no public
//     path from them back to `live`/`downEdge`/`upEdge`/`_rawPointerX` etc.
//
//   `fixedUpdate` runs entirely between one `beginFrame()` and the matching
//   `endFrame()` (engine.js phase 2, between phases 1 and 6). Whatever DOM
//   events land in that window are invisible to every reader — including
//   `fixedUpdate` — until the *next* `beginFrame()`. There is no code path,
//   public or private-but-reachable, that lets a reader see anything newer
//   than the snapshot `beginFrame()` last assembled. See
//   `tests/core/input.test.js` "the snapshot cannot observe live input..."
//   for this asserted directly.
//
// Node-safe: `window`/`document` are referenced only inside the bodies of
// `attach()`/`detach()` (and only behind a `typeof window !== 'undefined'`
// guard), never at module-evaluation time or in the constructor. Importing
// and constructing this module in Node never touches a browser global —
// `tests/core/input.test.js` relies on exactly that, and it is what
// `tools/check-imports.mjs` (TEST-2) will verify mechanically once it exists.
//
// Zero allocations in the frame-critical path: `beginFrame()`/`endFrame()`
// walk dense arrays (`_keyEntries`, `_buttons`) with plain indexed `for`
// loops — never `for...of` a Map/Set (that allocates an iterator per call,
// exactly the trap `ARCHITECTURE.md`'s event-bus note warns about) — and
// mutate existing objects (`this.pointer.x = ...`) rather than replacing
// them. The only allocations this module ever performs are: the fixed-size
// button array and the pre-registered key entries, both built once in the
// constructor, and one small state object the first time a *previously
// unseen* key code is touched (lazy growth, not a per-frame cost — see
// `_ensureKeyEntry`).

/**
 * Physical key codes (`KeyboardEvent.code`) this ticket's spec already names
 * as "will be needed downstream" (11-flows.md §3.2 and the CORE-7 brief):
 * `Q W E R` the belt, `1`-`4` the hotbar, `S` stop, the modifiers, `Tab`,
 * `I`, `Esc`. Pre-registered here purely so their first real keydown does
 * not pay the one-time lazy-allocation cost `_ensureKeyEntry` otherwise
 * incurs for a never-before-seen code — this module attaches no meaning to
 * any of them, that is `player`'s and `ui`'s job.
 */
const PRE_REGISTERED_KEY_CODES = [
  'KeyQ', 'KeyW', 'KeyE', 'KeyR',
  'Digit1', 'Digit2', 'Digit3', 'Digit4',
  'KeyS',
  'ShiftLeft', 'ShiftRight',
  'ControlLeft', 'ControlRight',
  'AltLeft', 'AltRight',
  'Tab', 'KeyI', 'Escape',
];

/** `PointerEvent.button` only ever takes values 0-4 (left/middle/right/back/forward). */
const BUTTON_COUNT = 5;

/** Builds one edge/snapshot record. Shape shared by keys and pointer buttons. */
function makeEdgeState() {
  return {
    live: false, // real-time down/up state; written by DOM handlers, read only by beginFrame()
    downEdge: false, // a down transition happened since the last beginFrame() drain
    upEdge: false, // an up transition happened since the last beginFrame() drain
    held: false, // this frame's snapshot: is it down
    pressed: false, // this frame's snapshot: did a press edge land since last beginFrame()
    released: false, // this frame's snapshot: did a release edge land since last beginFrame()
  };
}

export class Input {
  constructor() {
    /** @type {object[]} dense array of key edge/snapshot records. Iterated
     * by index in beginFrame()/endFrame() — never via Map iteration. */
    this._keyEntries = [];
    /** @type {Map<string, number>} KeyboardEvent.code -> index into `_keyEntries`. */
    this._keyIndexByCode = new Map();
    for (const code of PRE_REGISTERED_KEY_CODES) this._ensureKeyEntry(code);

    /** @type {object[]} fixed-size, index === PointerEvent.button. */
    this._buttons = [];
    for (let i = 0; i < BUTTON_COUNT; i++) this._buttons.push(makeEdgeState());

    // Raw pointer position, client coordinates, written by DOM handlers only.
    this._rawPointerX = 0;
    this._rawPointerY = 0;
    /** @type {{x:number,y:number}} public snapshot, mutated in place by
     * beginFrame() only. Client coordinates — unprojecting to the world is
     * `player`'s job (11-flows.md §3.3), not this module's. */
    this.pointer = { x: 0, y: 0 };

    // Raw wheel accumulator (sum of deltaY since the last drain) and its
    // public snapshot.
    this._rawWheelDeltaY = 0;
    /** @type {number} sum of `WheelEvent.deltaY` latched at the last
     * beginFrame(); re-derived fresh every frame, so it needs no endFrame()
     * clear — an empty window latches back to 0 on its own. */
    this.wheelDeltaY = 0;

    this._target = null;
    this._windowTarget = null;

    // Bound once so attach()/detach() always add/remove the identical
    // function reference, and so tests can invoke these directly as the
    // "internal receiver" the ticket allows in place of a real DOM.
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onBlur = this._onBlur.bind(this);
  }

  // ---- attach / detach --------------------------------------------------

  /**
   * Subscribes to DOM events. The only place this module ever touches
   * `window`/`document` — never at module-evaluation time, never in the
   * constructor. Pointer-down, wheel and the context-menu suppression (RMB
   * is a gameplay button per 11-flows.md §3.2 R5; without this the browser
   * eats the click as its own context menu) subscribe on `target` (the
   * canvas); keyboard, pointer-move/up and `blur` subscribe on `window`
   * since a drag or a key can end outside the canvas bounds.
   *
   * Safe to call again without an intervening `detach()` — the previous
   * target is detached first.
   *
   * @param {EventTarget} target - the canvas (or a stand-in exposing
   *   `addEventListener`/`removeEventListener`, e.g. in a test).
   */
  attach(target) {
    if (!target || typeof target.addEventListener !== 'function') {
      throw new Error('Input.attach: target must implement addEventListener');
    }
    if (this._target) this.detach();

    this._target = target;
    target.addEventListener('pointerdown', this._onPointerDown);
    target.addEventListener('wheel', this._onWheel, { passive: false });
    target.addEventListener('contextmenu', this._onContextMenu);

    const w = typeof window !== 'undefined' ? window : null;
    this._windowTarget = w;
    if (w) {
      w.addEventListener('keydown', this._onKeyDown);
      w.addEventListener('keyup', this._onKeyUp);
      w.addEventListener('pointermove', this._onPointerMove);
      w.addEventListener('pointerup', this._onPointerUp);
      w.addEventListener('blur', this._onBlur);
    }
  }

  /** Unsubscribes everything `attach()` subscribed. Safe to call when not attached. */
  detach() {
    if (this._target) {
      this._target.removeEventListener('pointerdown', this._onPointerDown);
      this._target.removeEventListener('wheel', this._onWheel);
      this._target.removeEventListener('contextmenu', this._onContextMenu);
      this._target = null;
    }
    if (this._windowTarget) {
      this._windowTarget.removeEventListener('keydown', this._onKeyDown);
      this._windowTarget.removeEventListener('keyup', this._onKeyUp);
      this._windowTarget.removeEventListener('pointermove', this._onPointerMove);
      this._windowTarget.removeEventListener('pointerup', this._onPointerUp);
      this._windowTarget.removeEventListener('blur', this._onBlur);
      this._windowTarget = null;
    }
  }

  // ---- frame boundary ----------------------------------------------------

  /**
   * Latches every raw edge accumulated since the previous `beginFrame()`
   * into the public snapshot, then clears the raw edge flags it just drained.
   * Allocates nothing — dense-array walks, in-place mutation only. Called
   * once per frame, first, by `engine.js` before any `fixedUpdate`.
   */
  beginFrame() {
    const keys = this._keyEntries;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      k.pressed = k.downEdge;
      k.released = k.upEdge;
      k.held = k.live;
      k.downEdge = false;
      k.upEdge = false;
    }

    const buttons = this._buttons;
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      b.pressed = b.downEdge;
      b.released = b.upEdge;
      b.held = b.live;
      b.downEdge = false;
      b.upEdge = false;
    }

    this.pointer.x = this._rawPointerX;
    this.pointer.y = this._rawPointerY;

    this.wheelDeltaY = this._rawWheelDeltaY;
    this._rawWheelDeltaY = 0;
  }

  /**
   * Clears the one-shot `pressed`/`released` flags this frame's
   * `beginFrame()` latched, so "pressed this frame" does not leak into the
   * next one. `held` is untouched — a key that is still down stays `held`.
   * Called once per frame, last, by `engine.js` after `render`.
   */
  endFrame() {
    const keys = this._keyEntries;
    for (let i = 0; i < keys.length; i++) {
      keys[i].pressed = false;
      keys[i].released = false;
    }

    const buttons = this._buttons;
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].pressed = false;
      buttons[i].released = false;
    }
  }

  // ---- public snapshot reads ---------------------------------------------

  /** @param {string} code - a `KeyboardEvent.code`, e.g. `'KeyW'`. @returns {boolean} */
  keyHeld(code) {
    const i = this._keyIndexByCode.get(code);
    return i === undefined ? false : this._keyEntries[i].held;
  }

  /** @param {string} code @returns {boolean} true only on the frame(s) the press edge latched */
  keyPressed(code) {
    const i = this._keyIndexByCode.get(code);
    return i === undefined ? false : this._keyEntries[i].pressed;
  }

  /** @param {string} code @returns {boolean} true only on the frame(s) the release edge latched */
  keyReleased(code) {
    const i = this._keyIndexByCode.get(code);
    return i === undefined ? false : this._keyEntries[i].released;
  }

  /** @param {number} button - `PointerEvent.button` (0 left, 1 middle, 2 right, 3 back, 4 forward). @returns {boolean} */
  buttonHeld(button) {
    const b = this._buttons[button];
    return b ? b.held : false;
  }

  /** @param {number} button @returns {boolean} */
  buttonPressed(button) {
    const b = this._buttons[button];
    return b ? b.pressed : false;
  }

  /** @param {number} button @returns {boolean} */
  buttonReleased(button) {
    const b = this._buttons[button];
    return b ? b.released : false;
  }

  // ---- internal: raw buffer, DOM-facing ----------------------------------

  /**
   * Returns the raw entry for `code`, creating one on first-ever use of a
   * code outside `PRE_REGISTERED_KEY_CODES`. This is the only place a new
   * key entry is allocated; it runs from a DOM keydown, not from a per-frame
   * path, so it is not a rule-6 violation — the cost is paid once per
   * distinct physical key ever pressed, not once per frame.
   * @param {string} code
   */
  _ensureKeyEntry(code) {
    let i = this._keyIndexByCode.get(code);
    if (i === undefined) {
      i = this._keyEntries.length;
      this._keyEntries.push(makeEdgeState());
      this._keyIndexByCode.set(code, i);
    }
    return this._keyEntries[i];
  }

  _onKeyDown(event) {
    if (event.repeat) return; // OS auto-repeat is not a new edge
    const k = this._ensureKeyEntry(event.code);
    k.downEdge = true;
    k.live = true;
  }

  _onKeyUp(event) {
    const k = this._ensureKeyEntry(event.code);
    k.upEdge = true;
    k.live = false;
  }

  _onPointerDown(event) {
    this._rawPointerX = event.clientX;
    this._rawPointerY = event.clientY;
    const b = this._buttons[event.button];
    if (!b) return;
    b.downEdge = true;
    b.live = true;
  }

  _onPointerUp(event) {
    this._rawPointerX = event.clientX;
    this._rawPointerY = event.clientY;
    const b = this._buttons[event.button];
    if (!b) return;
    b.upEdge = true;
    b.live = false;
  }

  _onPointerMove(event) {
    this._rawPointerX = event.clientX;
    this._rawPointerY = event.clientY;
  }

  _onWheel(event) {
    this._rawWheelDeltaY += event.deltaY;
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }

  _onContextMenu(event) {
    // Suppress the browser's context menu on RMB — RMB is a gameplay button
    // (11-flows.md §3.2 R5); this is capture plumbing, not gameplay meaning.
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }

  /**
   * `blur` on `window` (11-flows.md §12.3 #1): release every held key and
   * button so nothing is stuck down across a focus change. This only queues
   * an up-edge and clears `live` — it does not touch the public snapshot
   * directly, so `beginFrame()` remains the sole writer of `held`/`pressed`/
   * `released`. Nothing reads the snapshot again before the next
   * `beginFrame()` runs (no frames run while the tab is hidden — see
   * §12.1), so the release is visible exactly as promptly as it can be.
   */
  _onBlur() {
    const keys = this._keyEntries;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k.live) k.upEdge = true;
      k.live = false;
    }

    const buttons = this._buttons;
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (b.live) b.upEdge = true;
      b.live = false;
    }
  }
}
