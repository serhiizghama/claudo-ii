// src/ui/util.js
//
// UI-1 — the shared DOM/number helpers `09 §15 U0` names explicitly: `el`,
// `setText`, `setStyle`, `setClass`, `place`, easing (`clamp`, `lerp`,
// `damp`, `easeOutQuad`, `easeOutBack`), `Pool`, and the number LUT.
//
// ---------------------------------------------------------------------------
// Node-safety: a tiny DOM shim, not jsdom
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 3 forbids a new dependency (no jsdom), and
// `src/ui/` legitimately touches the real DOM (it is not a check-imports
// N-surface root — see `tools/check-imports.mjs`'s header). But this module
// is also imported by `tests/ui/ui1.test.js`, which runs under plain
// `node --test` (12-testing.md P6) — no `document` global exists there at
// all.
//
// The same "degrade gracefully under Node" discipline
// `tests/render/rndr1.test.js`'s header documents for `RenderSystem` (no
// WebGL2 in Node -> the degraded path runs, and nothing throws) is applied
// here for the DOM: `resolveDocument()` returns the real `document` in a
// browser, or a tiny internal shim otherwise. The shim implements exactly
// the surface `el()`/`style.js`/`index.js` need — `createElement`,
// `getElementById`, `head`/`body` — and every element it hands back has a
// live `.children` array, a `.classList` and a settable `.style` object, so
// `countNodes()` below (which walks `.children`, never
// `querySelectorAll('*')` — that call does not exist on the shim, and is a
// browser-only API this module never relies on) works identically whether
// the tree was built by a real `document.createElement` or by the shim.
// This is what lets `ui1.test.js` assert the U0 node count (9) without a
// browser, and lets the exact same code run for real once `main.js` boots
// in Chromium.
// ---------------------------------------------------------------------------

/** Minimal `classList` good enough for `add`/`remove`/`toggle`/`contains` —
 * used by the shim element below; real DOM elements already have a real one. */
function makeClassList(getClassName, setClassName) {
  function tokens() {
    const raw = getClassName();
    return raw ? raw.split(/\s+/).filter(Boolean) : [];
  }
  function write(list) {
    setClassName(list.join(' '));
  }
  return {
    add(name) {
      const list = tokens();
      if (!list.includes(name)) {
        list.push(name);
        write(list);
      }
    },
    remove(name) {
      write(tokens().filter((t) => t !== name));
    },
    toggle(name, force) {
      const has = tokens().includes(name);
      const on = force === undefined ? !has : !!force;
      if (on && !has) this.add(name);
      else if (!on && has) this.remove(name);
      return on;
    },
    contains(name) {
      return tokens().includes(name);
    },
  };
}

/** One shim element. Deliberately duck-typed to the exact subset of
 * `Element` this file's callers use — not a general DOM polyfill. */
function createShimElement(tag) {
  const node = {
    tagName: String(tag || '').toUpperCase(),
    children: [],
    parentNode: null,
    style: {},
    attributes: {},
    _className: '',
    _text: '',
    get className() {
      return node._className;
    },
    set className(v) {
      node._className = v;
    },
    get textContent() {
      return node._text;
    },
    set textContent(v) {
      node._text = v;
      // A text write, like the real DOM, clears any child elements — this
      // module never mixes text and element children on one node.
      node.children.length = 0;
    },
    setAttribute(name, value) {
      node.attributes[name] = String(value);
      if (name === 'id') node.id = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null;
    },
    appendChild(child) {
      child.parentNode = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = node.children.indexOf(child);
      if (i >= 0) node.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (node.parentNode) node.parentNode.removeChild(node);
    },
  };
  node.id = '';
  node.classList = makeClassList(
    () => node._className,
    (v) => {
      node._className = v;
    },
  );
  return node;
}

/** Lazily-built singleton — never constructed in a real browser, where
 * `resolveDocument()` returns the live `document` instead. */
let _shimDoc = null;
function shimDocument() {
  if (_shimDoc) return _shimDoc;
  const body = createShimElement('body');
  const head = createShimElement('head');
  _shimDoc = {
    head,
    body,
    createElement: createShimElement,
    getElementById(id) {
      const stack = [head, body];
      while (stack.length) {
        const n = stack.pop();
        if (n.id === id) return n;
        for (let i = 0; i < n.children.length; i++) stack.push(n.children[i]);
      }
      return null;
    },
  };
  return _shimDoc;
}

/** @returns {object} the real `document` in a browser, else the Node shim
 * above — see this file's header. */
export function resolveDocument() {
  return typeof document !== 'undefined' ? document : shimDocument();
}

// ---------------------------------------------------------------------------
// DOM helpers — `09 §15 U0`'s named list
// ---------------------------------------------------------------------------

/**
 * Creates an element via `resolveDocument()`. Never touches `document`
 * directly, so this stays Node-safe.
 * @param {string} tag
 * @param {string} [className]
 * @returns {object}
 */
export function el(tag, className) {
  const node = resolveDocument().createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * Writes `textContent` only when it actually changed — D-B's "no forced
 * reflow" discipline extends to skipping the write itself, not just a
 * layout read.
 * @param {object} node
 * @param {string} text
 */
export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

/**
 * Writes one inline style property, skipping the write if unchanged.
 * @param {object} node
 * @param {string} prop
 * @param {string} value
 */
export function setStyle(node, prop, value) {
  if (node.style[prop] !== value) node.style[prop] = value;
}

/**
 * Toggles a single class, skipping the write if already in the requested
 * state.
 * @param {object} node
 * @param {string} className
 * @param {boolean} on
 */
export function setClass(node, className, on) {
  if (node.classList.contains(className) !== !!on) node.classList.toggle(className, !!on);
}

/**
 * Arithmetic placement (D-B: `ui` never measures, only computes) via a GPU
 * transform, never `left`/`top` (those force layout on a mixed-position
 * ancestor chain; `transform` does not). Skips both the string build and
 * the DOM write when `(x, y)` is unchanged from the last call on this node —
 * the zero-allocation payoff for a HUD element that has stopped moving.
 * @param {object} node
 * @param {number} x
 * @param {number} y
 */
export function place(node, x, y) {
  if (node.__cl2X === x && node.__cl2Y === y) return;
  node.__cl2X = x;
  node.__cl2Y = y;
  node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

/**
 * Counts `root` itself plus every descendant element, walking `.children`
 * (not `querySelectorAll('*')`, which the Node shim does not implement —
 * see this file's header). Equal to `root.querySelectorAll('*').length + 1`
 * on a real DOM tree.
 * @param {object} root
 * @returns {number}
 */
export function countNodes(root) {
  let count = 1;
  const children = root.children;
  for (let i = 0; i < children.length; i++) count += countNodes(children[i]);
  return count;
}

// ---------------------------------------------------------------------------
// Easing / integration helpers — `09 §2.6`'s motion table names these by
// name; every one is a pure function of an integrated `t`, never wall clock.
// ---------------------------------------------------------------------------

/** @returns {number} `v` clamped to `[lo, hi]`. */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** @returns {number} linear interpolation between `a` and `b` at `t`. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * `09 §2.6`: `damp(current, target, rate, dt) = target + (current -
 * target)*e^(-rate*dt)` — frame-rate independent, the default approach curve
 * for every panel/orb/bar transition.
 */
export function damp(current, target, rate, dt) {
  return target + (current - target) * Math.exp(-rate * dt);
}

/** Standard ease-out-quad, `t` in `[0,1]`. */
export function easeOutQuad(t) {
  const u = 1 - t;
  return 1 - u * u;
}

/** Standard ease-out-back (overshoot then settle), `t` in `[0,1]` — used by
 * `09 §2.6`'s banner-in curve (`scale 1.06 -> 1.00`). */
export function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

// ---------------------------------------------------------------------------
// Pool — fixed-capacity, no Map (ARCHITECTURE.md rule 6 / this ticket's
// brief: "Map is banned for pooled state"). Same free-list-of-indices shape
// as `src/combat/packet.js#PacketPool` / `src/actors/pool.js#ActorPool` —
// that pair is this class's precedent.
// ---------------------------------------------------------------------------

export class Pool {
  /**
   * @param {number} capacity
   * @param {(index:number) => object} factory - builds one record; the
   *   factory should stamp its own index onto the record (e.g. `poolIndex`)
   *   the same way `createDamagePacket` does, so `release()` can find it
   *   again without a `Map`.
   * @param {((record:object) => void)|null} [reset] - clears a record's
   *   fields on acquire/release; optional.
   */
  constructor(capacity, factory, reset = null) {
    this._capacity = capacity;
    this._records = new Array(capacity);
    for (let i = 0; i < capacity; i++) this._records[i] = factory(i);

    this._freeSlots = new Int32Array(capacity);
    for (let i = 0; i < capacity; i++) this._freeSlots[i] = i;
    this._freeCount = capacity;

    this._inUse = new Uint8Array(capacity);
    this._reset = reset;
  }

  get capacity() {
    return this._capacity;
  }

  get activeCount() {
    return this._capacity - this._freeCount;
  }

  /** @returns {object|null} `null` when the pool is dry — the overflow
   * policy (drop, warn) is the caller's, not this pool's. */
  acquire() {
    if (this._freeCount === 0) return null;
    const slot = this._freeSlots[--this._freeCount];
    const rec = this._records[slot];
    if (this._reset) this._reset(rec);
    this._inUse[slot] = 1;
    return rec;
  }

  /**
   * Safe no-op on a double release or a record this pool doesn't own.
   * @param {object} rec
   * @param {number} slot - the record's own index (e.g. `rec.poolIndex`).
   */
  release(rec, slot) {
    if (!rec || slot === undefined || slot === null) return;
    if (slot < 0 || slot >= this._capacity || this._records[slot] !== rec) return;
    if (!this._inUse[slot]) return;
    if (this._reset) this._reset(rec);
    this._inUse[slot] = 0;
    this._freeSlots[this._freeCount++] = slot;
  }

  /** @param {(rec:object, slot:number) => void} fn - called for every
   * currently-active record, in slot order. Allocates nothing. */
  forEachActive(fn) {
    for (let slot = 0; slot < this._capacity; slot++) {
      if (this._inUse[slot]) fn(this._records[slot], slot);
    }
  }

  dispose() {
    this._freeCount = 0;
    this._inUse.fill(0);
  }
}

// ---------------------------------------------------------------------------
// The number LUT — `09 §15 U0`'s "and a number LUT in util.js for exactly
// this reason" (zero allocation per frame). Covers the range every per-frame
// HUD numeral actually displays (levels, stack counts, cooldown seconds,
// resonance pips); a value outside it is a cold path (e.g. a five-digit gold
// counter), so `String()` there is not a per-frame cost.
// ---------------------------------------------------------------------------

const NUMBER_LUT_SIZE = 256;
const NUMBER_LUT = new Array(NUMBER_LUT_SIZE);
for (let i = 0; i < NUMBER_LUT_SIZE; i++) NUMBER_LUT[i] = String(i);

/**
 * @param {number} n
 * @returns {string} the cached string for `0 <= n < 256` (integer), else a
 *   freshly allocated `String(n)`.
 */
export function numStr(n) {
  if (Number.isInteger(n) && n >= 0 && n < NUMBER_LUT_SIZE) return NUMBER_LUT[n];
  return String(n);
}
