// src/items/names.js
//
// ITEM-8 — rare item naming: the composer (`13-progression-lore.md` §10.2)
// and the 64-entry recent-name ring (`13` §10.3). PROGRESS D-25 is binding
// here and supersedes `04-items.md` §3.2-§3.5 wholesale:
//   - 56 heads x 48 tails = 2 688 combinations, not 44 x 48 = 2 112.
//   - TWO draws, `Ui(0,55)` then `Ui(0,47)` — never a third "epithet" draw;
//     the `affixCount >= 5` three-word branch (`04` §14.1 D-10) is dropped.
//   - the 64-entry ring (`13` §10.3) is in scope and guards rares (and
//     uniques, out of this ticket) so a 64-consecutive-rare window never
//     repeats a (head, tail) pair.
// See `docs/PROGRESS.md` D-25 for the full reasoning `04` lost on (its own
// worked example prints a genitive Russian result — "Рок Погибели" — against
// a tail table that yields nominative "Погибель", contradicting its own "no
// agreement machinery" claim; `13` actually solves case agreement and names
// this exact file).
//
// ---------------------------------------------------------------------------
// D13 draw consumption — the corrected number, for TEST-7 to assert
// ---------------------------------------------------------------------------
// `04` §9.2 says D13 consumes "2 or 3" — that is the superseded model and is
// wrong under D-25. The real rule, implemented below:
//   - one pair of draws, `Ui(0,55)` then `Ui(0,47)` = 2 draws.
//   - if the resulting (head, tail) code is already in the ring, redraw the
//     same pair — another 2 draws — up to 3 times (`13` §10.3:
//     `for (tries = 0; tries < 3 && ringContains(code); tries++) redraw()`).
//   - so D13 consumes **2, 4, 6 or 8 draws** — 2 with no collision, +2 per
//     redraw, capped at **8** (the initial pair plus at most 3 redraw
//     pairs). Never 3, never any odd number — every draw at D13 comes in a
//     head+tail pair.
// The redraws are ordinary draws off the same `items` stream, in fixed
// order (`13` §10.3: "the redraws are ordinary draws in fixed order") — no
// side stream, so a seed still reproduces a run bit-for-bit even across a
// ring collision.
//
// ---------------------------------------------------------------------------
// The ring lives here, at module scope — not on `ItemsSystem`
// ---------------------------------------------------------------------------
// `13` §10.3's pseudocode frames `recent`/`ringHead` as subsystem-instance
// state ("items, in init(): a fixed Int32Array"). This ticket's file
// allowlist only lets `src/items/index.js` be touched as a re-export and
// `src/items/roll.js` only at the marked D13 insertion point — neither is a
// legal place to add an instance field to `ItemsSystem`. Module-level state
// here is the same shape `src/items/roll.js`'s own `uniquePoolSource`
// (ITEM-7) already uses for an equivalent problem, and it keeps
// `tools/lootsim.mjs`'s bare `import './roll.js'` path (no `ItemsSystem`, no
// `init()` — see that file's own header) producing real, ring-guarded rare
// names with zero setup. `resetRareRing()` is exported so
// `src/items/index.js` can wire it to `zone:enter` (`13` §10.3: "reset on
// zone:enter").
//
// `Int32Array(64)`, scanned linearly on every check — no `Map`, no `Set`, no
// array that gets `.push()`ed (this ticket's brief, measured: a `Map` leaks
// ~456 B/call on never-repeating keys even with one live entry, and
// `Map.prototype.clear()` allocates unconditionally). 64 integer comparisons
// per check is nothing.
//
// The ring is zero-initialised (`new Int32Array(64)`, per `13` §10.3's own
// pseudocode — it does not fill with a sentinel either), and code `0` (head
// 0, tail 0) is a legal code. Consequence: the very first time code 0 would
// ever be drawn, it appears to "collide" with the ring's own untouched
// state before anything has actually been pushed. This can only cost one
// harmless extra redraw — a redraw always draws a fresh code and only the
// final code is written into the ring — so it never causes an actual
// repeat and does not threaten the zero-repeat guarantee. Transcribed as
// specified rather than "fixed" with a sentinel this ticket was not asked
// to invent.

import { RARE_HEAD, RARE_TAIL } from './data/names.js';

const RING_SIZE = 64;
const ringCodes = new Int32Array(RING_SIZE); // zero-initialised, see header
let ringHead = 0;

/**
 * Linear scan over the ring — the "only allocation-free answer" this
 * ticket's brief calls for (64 integer comparisons, no allocation).
 * @param {number} code
 * @returns {boolean}
 */
function ringContains(code) {
  for (let i = 0; i < RING_SIZE; i++) {
    if (ringCodes[i] === code) return true;
  }
  return false;
}

/**
 * Writes `code` at the ring's current head and advances it. Never grows the
 * backing store (`ARCHITECTURE.md`-adjacent perf rule this ticket's brief
 * restates: `array.length = 0` tears the backing store, so this never
 * resets `ringCodes` itself — only `resetRareRing()` below does, by writing
 * zeros in place). Allocation-free.
 * @param {number} code
 */
function pushRareCode(code) {
  ringCodes[ringHead & (RING_SIZE - 1)] = code;
  ringHead++;
}

/**
 * `13` §10.3: "reset on `zone:enter`". Wired by `src/items/index.js`'s
 * `ctx.events.on('zone:enter', ...)` subscription. Writes zeros into the
 * existing `Int32Array` in place — no new array, no reallocation.
 */
export function resetRareRing() {
  ringCodes.fill(0);
  ringHead = 0;
}

/**
 * `13` §10.2's composition rule, Ruling B of this ticket's brief:
 *   - English: `head.en + ' ' + tail.en`, or `head.en + ' of ' + tail.en`
 *     when `tail.def` is true (the tail's own authored property — never a
 *     string inspection on the generator's part; `tail.en` for a `def` tail
 *     already includes the leading "the", e.g. "the Instructor").
 *   - Russian: `head.ru + ' ' + tail.ru`, plain concatenation — the tail is
 *     pre-inflected genitive (rule G3, `13` §10.4) so no agreement is ever
 *     needed regardless of the head's gender.
 * Pure; allocates the two result strings (inherent, not a per-frame path —
 * see this ticket's brief) and nothing else.
 * @param {number} headIndex - 0..55, an index into `RARE_HEAD`.
 * @param {number} tailIndex - 0..47, an index into `RARE_TAIL`.
 * @returns {{en: string, ru: string}}
 */
export function composeRareName(headIndex, tailIndex) {
  const head = RARE_HEAD[headIndex];
  const tail = RARE_TAIL[tailIndex];
  const en = tail.def ? head.en + ' of ' + tail.en : head.en + ' ' + tail.en;
  const ru = head.ru + ' ' + tail.ru;
  return { en, ru };
}

/**
 * D13 (`04` §9.2's slot in the draw order; `13` §10.3's ring — PROGRESS
 * D-25 overrides `04` §3's ranges/count entirely, see file header). Draws
 * `Ui(0,55)` then `Ui(0,47)`; if the resulting (head, tail) pair collided
 * with one of the ring's last 64 codes, redraws the same pair (another 2
 * draws) up to 3 times, then keeps whatever the loop ends on — the ring
 * makes a repeat astronomically unlikely, it does not promise to eliminate
 * one outright (`13` §10.3's own algorithm: the `for` loop's own exit
 * condition, not a `while (true)`). Every accepted code — first draw or a
 * later redraw — is written into the ring exactly once.
 *
 * Consumes 2, 4, 6 or 8 draws, never 3 or any odd number (see file header).
 *
 * @param {import('../core/rng.js').Rng} rng - the `items` stream. This is
 *   the SAME `rng` argument `rollItem` already receives — no new
 *   `rng.fork()` here (`ARCHITECTURE.md` hard rule 4 / Determinism
 *   contract: one fork per subsystem, taken once in `init()`).
 * @returns {{headIndex: number, tailIndex: number, code: number, en: string, ru: string}}
 */
export function rollRareName(rng) {
  const nTail = RARE_TAIL.length; // 48
  let headIndex = rng.int(0, RARE_HEAD.length - 1); // Ui(0,55)
  let tailIndex = rng.int(0, nTail - 1); // Ui(0,47)
  let code = headIndex * nTail + tailIndex;
  for (let tries = 0; tries < 3 && ringContains(code); tries++) {
    headIndex = rng.int(0, RARE_HEAD.length - 1); // redraw, Ui(0,55)
    tailIndex = rng.int(0, nTail - 1); // redraw, Ui(0,47)
    code = headIndex * nTail + tailIndex;
  }
  pushRareCode(code);
  const { en, ru } = composeRareName(headIndex, tailIndex);
  return { headIndex, tailIndex, code, en, ru };
}

// Exported for the ring's own allocation probe (tests/items/names.perf.test.js)
// and the sliding-window repeat proof (tests/items/names.test.js) — pure
// integer operations, no rng, no string building, so a probe on these two
// alone isolates the ring's own allocation behaviour from
// `composeRareName`'s inherent (and accepted, see file header) string
// allocation.
export const __ring = Object.freeze({ contains: ringContains, push: pushRareCode, size: RING_SIZE });
