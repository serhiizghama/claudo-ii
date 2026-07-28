// src/dev/shots.js
//
// TEST-3 — the named-shot registry and the lockstep frame pump
// (docs/spec/12-testing.md §9's "the simulation is stepped in lockstep by
// src/dev/shots.js").
//
// ---------------------------------------------------------------------------
// What lives here, and what does not
// ---------------------------------------------------------------------------
// A "shot" is a named, fully-deterministic point in the simulation that
// `tools/capture.mjs` (and, later, TEST-15's `tools/baseline.mjs`) freezes
// into a PNG. Each entry in `SHOTS` describes:
//   - `id`          the shot's name — the key it is registered under, repeated
//                    here so a consumer holding just the descriptor object
//                    still knows its own name.
//   - `description` what the shot pins (12-testing.md §9.1's "What it pins"
//                    column), verbatim.
//   - `milestone`   which milestone introduces it (12-testing.md §9.1's
//                    "From" column) — never used for logic, only so a bless
//                    diff or a report can say *why* a shot exists.
//   - `steps`       how many ADDITIONAL fixed steps to pump via
//                    `engine.frame(FIXED_DT)` — never rAF — before the pixels
//                    are read. This is on top of whatever `src/main.js`'s own
//                    boot sequence already ran (`BOOT_FRAMES = 3`, landed by
//                    the time `window.__READY__` is observed — see
//                    `src/main.js`'s header, "Lockstep vs rAF"). `boot_clean`
//                    is captured at exactly that point, so `steps: 0`.
//   - `setup`       optional `(engine, ctx) => void`, run once before the
//                    pump — e.g. a future `dense_combat` shot spawning
//                    monsters. `boot_clean` needs none (`null`); the field
//                    exists so later shots slot into this same shape without
//                    a redesign, per this ticket's brief.
//
// Only `boot_clean` (M0) is registered today. `12-testing.md` §9.1 names
// eleven more (`town_overview`, `dense_combat`, …) arriving in M3–M7 — those
// are explicitly out of this ticket's scope; adding them is whichever later
// ticket lands the subsystem each one depends on (world, ai, items, skills…).
//
// This module does NOT touch `three`, the DOM or any subsystem directly — it
// is imported by `tools/capture.mjs` (Node) to read the registry, and
// `pumpShot`'s source is injected into the browser page verbatim (see
// `tools/capture.mjs`'s header for why) to actually drive the frames there.
// Both uses need the same guarantee: zero free variables, zero side effects
// at import time.
//
// ---------------------------------------------------------------------------
// `pumpShot` is written to survive `Function.prototype.toString()` + `eval`
// ---------------------------------------------------------------------------
// `tools/capture.mjs` cannot reach into the headless page's own `Engine`
// instance (`window.__ENGINE__`) from Node — it lives in a different JS
// realm. So the pump has to run INSIDE the page. Rather than hand-rolling the
// same stepping loop a second time in `capture.mjs` (two copies of "the"
// lockstep pump is exactly the kind of drift this file exists to prevent),
// `capture.mjs` takes `pumpShot.toString()` and evaluates it in the page.
// That only works if the function closes over nothing outside its own
// parameter list — no imported `FIXED_DT`, no reference to `SHOTS`, nothing.
// Every value it needs (`engine`, `steps`, `fixedDt`) is passed in explicitly.

import { FIXED_DT } from '../core/engine.js';

export { FIXED_DT };

/** @typedef {{ id: string, description: string, milestone: string, steps: number, setup: ((engine: object, ctx: object) => void) | null }} ShotDescriptor */

/** @type {Record<string, ShotDescriptor>} */
export const SHOTS = {
  boot_clean: {
    id: 'boot_clean',
    description: 'the first frame, empty scene, camera at rest',
    milestone: 'M0',
    steps: 0,
    setup: null,
  },
};

/** @returns {string[]} every registered shot name, sorted. */
export function listShotNames() {
  return Object.keys(SHOTS).sort();
}

/**
 * @param {string} name
 * @returns {ShotDescriptor}
 * @throws if `name` is not registered — the message lists every valid name,
 *   so a typo'd `--shot` is diagnosable from the error alone.
 */
export function getShot(name) {
  const shot = SHOTS[name];
  if (!shot) {
    throw new Error(`shots.js: unknown shot "${name}" (valid: ${listShotNames().join(', ')})`);
  }
  return shot;
}

/**
 * The lockstep pump: runs `steps` fixed steps through `engine.frame(fixedDt)`
 * — never `requestAnimationFrame`, never a wall-clock `dt` — so a shot's
 * pixels are a pure function of the seed and the step count, not of how long
 * anything took to run (12-testing.md §9.2). Deliberately free of every
 * closure — see this file's header — so its source can be lifted verbatim
 * into a page context that has no access to this module at all.
 *
 * @param {{ frame: (dt: number) => number }} engine - anything shaped like
 *   `src/core/engine.js`'s `Engine` (duck-typed, not imported, so this stays
 *   evaluable outside this module's own realm).
 * @param {number} steps
 * @param {number} fixedDt
 * @returns {number} the number of steps actually pumped (always `steps`;
 *   returned so a caller can log/assert on it without re-deriving it).
 */
export function pumpShot(engine, steps, fixedDt) {
  let ran = 0;
  for (let i = 0; i < steps; i++) {
    engine.frame(fixedDt);
    ran += 1;
  }
  return ran;
}
