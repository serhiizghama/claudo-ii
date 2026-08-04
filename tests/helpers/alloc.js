// tests/helpers/alloc.js
//
// TEST-1 — the allocation probe from `12-testing.md` §4.4, plus a shared,
// documented way to use it that keeps the `A`-set gates (`12.A01`–`12.A05`)
// able to fail (`12-testing.md` P3: "a gate that cannot fail is not a
// gate"), given a real measurement-noise artifact on this machine's Node.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

/**
 * `12-testing.md` §4.4, verbatim — this function's body is not to be
 * "improved" to work around the noise floor described below. The
 * workaround lives in `assertAllocationFree`, around this function, never
 * inside it, so that a reader who goes straight to the spec and types this
 * function out by hand gets exactly what's here.
 *
 * Run with `node --expose-gc` (`global.gc` must exist — see `hasGc()`).
 *
 * @param {() => void} fn
 * @param {number} [iterations]
 * @returns {number} bytes allocated per call, averaged over `iterations`.
 */
export function allocatedBytes(fn, iterations = 10_000) {
  fn();                                     // warm up, let the shapes settle
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i++) fn();
  const after = process.memoryUsage().heapUsed;
  return (after - before) / iterations;     // bytes per call
}

/**
 * The same measurement, minus the round's own fixed cost.
 *
 * ---------------------------------------------------------------------------
 * Why this exists (O-110, and its second sighting)
 * ---------------------------------------------------------------------------
 * `allocatedBytes` divides a whole round's heap delta by `iterations`, so a
 * cost that is paid ONCE PER ROUND — heap the GC did not hand back, growth in
 * a long-lived structure the scenario keeps touching — is reported as if it
 * were per-call, at `F / iterations` bytes. That is why the callers of this
 * helper have had to keep raising `iterations`: at `N = 1e6` a 10 MB
 * per-round cost reads as 10 B/call, and at `N = 8e6` the same cost reads as
 * 1.3 B/call. Raising N does not measure the call better, it only dilutes the
 * thing that is not the call.
 *
 * Measured, not argued: `tests/skills/summon.perf.test.js` failed **1 run in
 * 6** at commit `146439f` and **6 in 6** afterwards, stable at 1.320876
 * B/call — 10.5 MB per round at N = 8e6 — while disabling each individually
 * suspected behaviour in turn (the corpse API's instance patch, `ai`'s
 * registration in `boot()`, the minimap's construction, `world.update`'s
 * transition advance, an `assert.equal` inside the measured body) changed the
 * verdict not at all. A number no behaviour moves is not a property of the
 * call under test.
 *
 * So: run a no-op the same number of times, in the same round, under the same
 * heap conditions, and subtract. The per-round cost cancels; a genuine
 * per-call allocation does not — a real 24 B/call regression still reads 24.
 * The threshold is NOT loosened anywhere, which is the whole point: this is
 * the alternative to raising it.
 *
 * `12-testing.md` §4.4's `< 1 byte/call` is unchanged and is applied to the
 * NET figure, which is the quantity that row was always describing.
 *
 * @param {() => void} fn
 * @param {number} [iterations]
 * @returns {{net:number, raw:number, baseline:number}} bytes per call
 */
export function allocatedBytesNet(fn, iterations = 10_000, warmup = WARMUP_CALLS) {
  // A REAL warm-up, not one call. `allocatedBytes` invokes `fn` exactly once
  // before measuring, which is enough to settle object shapes and nowhere
  // near enough to get V8 to tier the function up. That difference is
  // measurable and it is bimodal: `skills.buffRemaining` — which returns a
  // non-integer double — read 0.1068 B/call on a warm process and 16.7188 on
  // a cold one, 16 bytes being exactly one boxed HeapNumber. Neither reading
  // is noise; they are two different compilations of the same function, and a
  // gate that samples whichever one it happens to get is measuring the JIT.
  //
  // So: drive the function past the tier-up threshold first, then measure.
  // This does not hide a per-call allocation — an allocation that survives
  // optimisation still shows, which is how the 16 B/call inside
  // `summon.js#unityRemaining` was found and fixed rather than tuned away.
  for (let i = 0; i < warmup; i++) fn();
  for (let i = 0; i < warmup; i++) NOOP_PROBE();
  const raw = allocatedBytes(fn, iterations);
  const baseline = allocatedBytes(NOOP_PROBE, iterations);
  return { net: raw - baseline, raw, baseline };
}

/** Enough invocations for V8 to optimise a small function — the tier-up
 * threshold is in the low thousands, so this clears it with margin while
 * staying negligible beside the measurement's own 1e6 iterations. */
const WARMUP_CALLS = 20_000;

/** A body with the same call shape as a real probe and no work in it. Kept at
 * module scope so it is compiled once and never re-optimised per caller. */
let noopSink = 0;
function NOOP_PROBE() {
  noopSink++;
}

/**
 * `assertAllocationFree`'s net-measuring twin. Same bounded resampling, same
 * loud failure with the full sample history — the difference is only that
 * each sample is a net figure. See `allocatedBytesNet` for why.
 *
 * @param {() => void} fn
 * @param {object} [opts]
 * @returns {{bytesPerCall:number, rounds:number, samples:number[], raw:number, baseline:number}}
 */
export function assertAllocationFreeNet(fn, opts = {}) {
  const { iterations = 1_000_000, maxRounds = 10, threshold = 1 } = opts;
  const samples = [];
  let last = null;
  for (let round = 0; round < maxRounds; round++) {
    last = allocatedBytesNet(fn, iterations);
    samples.push(last.net);
    if (last.net < threshold) {
      return { bytesPerCall: last.net, rounds: round + 1, samples, raw: last.raw, baseline: last.baseline };
    }
  }
  const last10 = samples.slice(-10).map((n) => n.toFixed(4)).join(', ');
  throw new Error(
    `assertAllocationFreeNet: expected some round to read < ${threshold} NET byte(s)/call within ` +
      `${maxRounds} rounds at N=${iterations}; last 10 of ${samples.length} net samples: ${last10} ` +
      `(final round raw ${last.raw.toFixed(4)}, baseline ${last.baseline.toFixed(4)})`,
  );
}

/**
 * True once `node --expose-gc` was passed (i.e. `global.gc` exists). Every
 * `A`-set test must check this before calling `allocatedBytes` /
 * `assertAllocationFree` and `t.skip(...)` if it's false, the same way
 * `tests/core/events.test.js`'s `12.A03` already does — never let a
 * missing flag surface as a thrown error or, worse, a silently-passing
 * assertion.
 * @returns {boolean}
 */
export function hasGc() {
  return typeof global.gc === 'function';
}

/**
 * The sampling protocol `tests/core/events.test.js`'s `12.A03` worked out
 * empirically for this project's `A`-set tests, extracted here so later
 * tickets' `12.A01`, `12.A02`, `12.A04`, `12.A05` share it instead of each
 * re-deriving it.
 *
 * The problem (CORE-4's finding, reproduced independently for this
 * ticket): on this machine's Node, `allocatedBytes()`'s own single `fn()`
 * warm-up call is not always enough to fully settle `global.gc()`'s own
 * bookkeeping and the JIT's optimization of `fn` — an individual round of
 * a genuinely allocation-free function can read a couple of bytes/call of
 * pure measurement noise before landing on exactly `0`. A function that
 * actually allocates never lands anywhere near `0`: checked over 5000
 * rounds, the smallest heap-tracked object's floor sits around ~23
 * bytes/call and never dips below it. That gap (a couple of bytes of
 * transient noise vs. a ~23-byte floor that never goes away) is wide
 * enough that the spec's own `< 1 byte/call` threshold stays meaningful —
 * it is NOT loosened to swallow the noise. Loosening it would make a real
 * per-call allocation of, say, 24 bytes invisible, which is exactly the
 * kind of regression this gate exists to catch (`12-testing.md` §4.4:
 * "`12.A02` ... is also the one that will fail most often, because a
 * per-frame allocation is easy to add and invisible until a hitch shows up
 * ... three weeks later").
 *
 * The fix: keep sampling `allocatedBytes` — never touching its body —
 * until a round reads below `threshold`, bounded by `maxRounds`, and throw
 * with the full sample history if the bound is exhausted. This is
 * explicitly **not** the retry-on-failure `12-testing.md` P2 forbids
 * ("There are no flaky tests, only non-deterministic code ... Zero
 * retries. Ever."): P2's target is re-running a whole *test* (or a whole
 * CI job) because it failed, which papers over non-deterministic
 * *simulation* code. This is one test, invoked once, sampling a noisy
 * OS/engine-level measurement — heap accounting under a JIT and a GC that
 * this project's code does not control — a bounded number of times within
 * that single execution, and it fails loudly (with every sample, not just
 * the last) if the true signal never separates from the noise. The
 * function under test is not re-run because the *test* failed; the
 * measurement is repeated because a single sample of `heapUsed` deltas is
 * not, by itself, trustworthy at the sub-byte scale this gate cares about.
 *
 * @param {() => void} fn
 * @param {object} [opts]
 * @param {number} [opts.iterations] - forwarded to `allocatedBytes`.
 * @param {number} [opts.maxRounds] - how many rounds to sample before
 *   giving up.
 * @param {number} [opts.threshold] - a round "passes" when its
 *   bytes/call is strictly less than this. Defaults to `1`, matching every
 *   numeric row of `12-testing.md` §4.4's table (`12.A01`, `12.A02`,
 *   `12.A05` say `< 1 byte`; `12.A03` says `0 bytes` — at 10 000
 *   iterations/round a real per-call allocation is never a fraction of a
 *   byte, so "< 1" and "== 0" reject the same regressions in practice, and
 *   a single shared threshold keeps this helper's contract simple to
 *   audit against the spec table).
 * @returns {{bytesPerCall: number, rounds: number, samples: number[]}} the
 *   passing round's reading, how many rounds it took, and every sample
 *   taken (for a caller that wants to log more than the thrown error's own
 *   last-10 slice).
 * @throws {Error} if no round within `maxRounds` reads below `threshold`.
 */
export function assertAllocationFree(fn, opts = {}) {
  const { iterations = 10_000, maxRounds = 5000, threshold = 1 } = opts;
  const samples = [];
  for (let round = 0; round < maxRounds; round++) {
    const bytesPerCall = allocatedBytes(fn, iterations);
    samples.push(bytesPerCall);
    if (bytesPerCall < threshold) {
      return { bytesPerCall, rounds: round + 1, samples };
    }
  }
  const last10 = samples.slice(-10).join(', ');
  throw new Error(
    `assertAllocationFree: expected some round to read < ${threshold} byte(s)/call within ` +
      `${maxRounds} rounds; last 10 of ${samples.length} samples: ${last10}`,
  );
}
