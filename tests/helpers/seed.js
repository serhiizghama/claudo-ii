// tests/helpers/seed.js
//
// TEST-1 — fixed seeds for deterministic tests.
//
// 12-testing.md P2: "There are no flaky tests, only non-deterministic
// code... every input is seeded. Zero retries. Ever." That includes the
// seeds themselves: a test file that invents its own ad hoc numeric
// literal every time it needs a seed is fine for determinism (a literal is
// still fixed), but it is bad for triage — a failure report that says
// "seed 0x5eed1234" is greppable across the whole suite and the spec;
// fifty different one-off literals scattered through tests/ are not. Reuse
// what's exported here.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

/**
 * The deterministic-mode seed. `11-flows.md` §1 (stage B2) and §14.2 pin
 * this exact literal: `ctx.rng = new Rng(config.deterministic ? 0x5eed1234
 * : worldSeed)` — it is what `?capture=1` and the harnesses run against
 * instead of a real `worldSeed` draw. `tests/core/rng.test.js`'s reference
 * vector is already captured at this seed; every other test that needs
 * "the" fixed seed (as opposed to a second, independent one) should use
 * this same constant rather than re-typing the literal.
 * @type {number}
 */
export const DETERMINISTIC_SEED = 0x5eed1234;

/**
 * A small table of additional fixed seeds, for tests that need more than
 * one independent, reproducible starting point (e.g. comparing two
 * unrelated `Rng` instances, or running the same case across a short table
 * of scenarios) without reaching for `Math.random()` or a wall-clock-
 * derived value. Arbitrary but fixed — pick any entry below, or add one in
 * the same shape (an 8-hex-digit literal, name says what it's for), never
 * an inline magic number that isn't exported from here.
 * @type {Readonly<Record<string, number>>}
 */
export const SEEDS = Object.freeze({
  deterministic: DETERMINISTIC_SEED,
  a: 0xa11ce001,
  b: 0xb0b00002,
  c: 0xc0ffee03,
});
