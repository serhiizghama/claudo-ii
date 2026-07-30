// tests/actors/anim.perf.test.js
//
// ACTR-12 acceptance tests for src/actors/anim.js — `08 §11 step 6`'s TIME
// and ALLOCATION halves: "`update()` allocates 0 bytes over 600 frames
// (heap sampled)" and "pose + skeleton cost < 1.5 ms at 26 actors". Named
// `.perf.test.js` per D-11 (a test asserting a time/allocation/frame count
// lands in the isolated `--test-concurrency=1` stage) — the correctness
// half (masks, layering, the discontinuity investigation) lives in the
// sibling `anim.test.js`.
//
// O-43: allocation probes are meaningless below ~1M iterations on this
// project's measured noise floor. This file does NOT use
// `tests/helpers/alloc.js`'s `assertAllocationFree` (its default
// `iterations: 10_000` is exactly the regime O-43 says is unusable) — it
// samples `allocatedBytes` directly at two large Ns and judges by TOTAL
// bytes growing (or not) between them, the same methodology
// `tests/combat/resolve.perf.test.js`'s `12.A05` already established. Per
// the ticket brief's own instruction ("measure it by total bytes across
// many repetitions of the 600-frame run"), the measured UNIT here is not
// one `updateAnimator()` call but one full 600-FRAME RUN, repeated N times.
//
// Rule 12 ("pair a time criterion with proof the work was done"): the
// 26-actor timing test also asserts `bonesWritten` sums to exactly
// `26 * boneCount`, so a regression that silently skips actors or bones to
// stay fast cannot pass alongside a green latency number (the exact failure
// mode this project has already been bitten by once, per the ticket brief).
//
// ---------------------------------------------------------------------------
// Post-acceptance fix — the allocation gate flaked, and the actual bug
// ---------------------------------------------------------------------------
// The coordinator, ACTR-13 and one of my own isolated re-runs all found the
// same thing: the allocation gate landed within noise of the 1 B/frame
// bound (borderline fails, ~0.7-1.2 B/frame). Two things were wrong, one a
// real (harness) bug, one a real measurement-methodology gap — neither is
// `src/actors/anim.js`'s own fault:
//
// 1. **A real bug in THIS test's own harness, not in `updateAnimator`.** The
//    per-round closure below used to build a FRESH `{ speed, overrideStateId,
//    ..., springTargets: {...} }` object literal on every one of the 600
//    inner calls — that is a real allocation, made by the TEST, that was
//    being counted against `updateAnimator`'s own budget. V8's escape
//    analysis elides some but not all of that under `--expose-gc` (which
//    itself perturbs optimization), which is exactly the kind of
//    borderline, run-to-run-dependent reading that was observed. Fixed:
//    `input`/`springTargets` are now built ONCE, outside every timed
//    closure, and only their fields are mutated per call — the same
//    "preallocate in the test, mutate in place" discipline this ticket's
//    own `src/actors/anim.js` already follows, now applied to the test
//    harness measuring it.
// 2. **N was still too small, per O-43's own numbers.** O-43 measured a
//    genuinely allocation-free path at 80 B/call at N=10k, settling to
//    0.33 B/call only around N=4M *real calls*. The previous version's
//    larger sample was N=8000 *rounds* of 600 calls = 4.8M calls — already
//    near that floor for a SINGLE sample, but a single sample at the edge
//    of convergence is exactly what "flakes" — one unlucky GC pause still
//    swings the reading past the bound. The fix here is not a bigger single
//    N (isolation is already spent — this file is already in the
//    `--test-concurrency=1` stage) but REPEATED sampling at large N, judged
//    by the MEDIAN, with the full min/median/max spread printed so a future
//    reader can see the estimate has actually converged rather than that one
//    lucky draw passed. The bound stays `< 1 B/frame` — unchanged, per O-21/
//    O-23/O-43's own standing rule that a flake is fixed by measurement, not
//    a loosened threshold.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hasGc, allocatedBytes } from '../helpers/alloc.js';
import { createSkeleton } from '../../src/actors/rig.js';
import { createAnimatorState, updateAnimator } from '../../src/actors/anim.js';
import { ARCHETYPE_SPEEDS } from '../../src/actors/clips.js';

const DT = 1 / 60;
const FRAMES_PER_RUN = 600; // 08 §11 step 6's own figure

// ---------------------------------------------------------------------------
// 08 §11 step 6 — "update() allocates 0 bytes over 600 frames"
// ---------------------------------------------------------------------------

function median(sortedOrNot) {
  const arr = [...sortedOrNot].sort((a, b) => a - b);
  return arr[Math.floor(arr.length / 2)];
}

test('08 §11 step 6 | updateAnimator() allocates 0 bytes over 600 frames (O-43 methodology, raised N, repeated + median-judged per the coordinator\'s flake fix)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const rig = createSkeleton('humanoid');
  const state = createAnimatorState(rig);
  const overrideDelta = new Float32Array(rig.boneCount * 3);
  overrideDelta[0] = 5; // nonzero, so the L2 masked-accumulation branch is exercised too, not skipped

  // Preallocated ONCE, mutated in place per call — see the file header's
  // "Post-acceptance fix" note. Building a fresh `{...}` (and a fresh
  // `springTargets: {...}`) inside the timed loop was this test's own
  // allocation, wrongly counted against `updateAnimator`'s budget.
  const springTargets = { weaponInertia: 2, headLag: 1, shieldBob: 1, hitShake: 0 };
  const input = {
    speed: 0, overrideStateId: null, overrideDelta: null,
    leanTargetChestDeg: 5, leanTargetNeckDeg: 3, springTargets,
  };
  let frame = 0;

  // One "unit" of measurement is a full 600-frame run — a walk/run/idle
  // cycle plus a state override engaging and releasing, so every code path
  // `updateAnimator` owns (L1 crossfade, L2 override + its fade-out, L3
  // breath + triggered overlays, L4 springs, the skeleton compose) runs
  // every round, not just the cheapest path.
  const runSixHundredFrames = () => {
    for (let i = 0; i < FRAMES_PER_RUN; i++) {
      frame++;
      input.speed = ARCHETYPE_SPEEDS.bone_ranker.run * (0.5 + 0.5 * Math.sin(frame * 0.01));
      const overrideOn = (frame % 200) < 100;
      input.overrideStateId = overrideOn ? 'attack.windup' : null;
      input.overrideDelta = overrideOn ? overrideDelta : null;
      updateAnimator(state, input, DT);
    }
  };

  // Raised per the coordinator: N_SMALL/N_LARGE are ROUNDS of 600 calls, so
  // total real `updateAnimator()` calls per sample are 4.8M / 14.4M — both
  // already at or past O-43's own "settles around 4M calls" figure. The fix
  // for flakiness at this N is not a bigger single sample but REPEATING the
  // whole two-N marginal computation and judging by the median, with the
  // full spread printed (isolation is already spent — this file already
  // runs in the `--test-concurrency=1` stage).
  const N_SMALL = 8000; // 4.8M calls
  const N_LARGE = 24000; // 14.4M calls
  const REPEATS = 5;

  const smallSamples = [];
  const largeSamples = [];
  const marginalsPerFrame = [];

  for (let r = 0; r < REPEATS; r++) {
    const bytesPerRunSmall = allocatedBytes(runSixHundredFrames, N_SMALL);
    const bytesPerRunLarge = allocatedBytes(runSixHundredFrames, N_LARGE);
    smallSamples.push(bytesPerRunSmall);
    largeSamples.push(bytesPerRunLarge);

    const totalSmall = bytesPerRunSmall * N_SMALL;
    const totalLarge = bytesPerRunLarge * N_LARGE;
    const marginalBytesPerRun = (totalLarge - totalSmall) / (N_LARGE - N_SMALL);
    marginalsPerFrame.push(marginalBytesPerRun / FRAMES_PER_RUN);
  }

  const fmt = (arr) => `min=${Math.min(...arr).toFixed(4)} median=${median(arr).toFixed(4)} max=${Math.max(...arr).toFixed(4)}`;

  console.log(`[08 §11 step 6] alloc: B/600-frame-run @ N=${N_SMALL} across ${REPEATS} repeats: ${fmt(smallSamples)}`);
  console.log(`[08 §11 step 6] alloc: B/600-frame-run @ N=${N_LARGE} across ${REPEATS} repeats: ${fmt(largeSamples)}`);
  console.log(`[08 §11 step 6] alloc: marginal B/frame across ${REPEATS} repeats: ${fmt(marginalsPerFrame)} ` +
    `(individual: ${marginalsPerFrame.map((v) => v.toFixed(4)).join(', ')})`);

  const medianMarginal = median(marginalsPerFrame);
  assert.ok(
    medianMarginal < 1,
    `updateAnimator() must allocate < 1 byte/frame over 600 frames, median of ${REPEATS} repeated marginal ` +
      `measurements at N=${N_SMALL}/${N_LARGE} rounds; got median=${medianMarginal.toFixed(6)} B/frame ` +
      `(spread: ${fmt(marginalsPerFrame)}) — this would be a real per-frame allocation, not a measurement artifact`,
  );
});

// ---------------------------------------------------------------------------
// 08 §11 step 6 — "pose + skeleton cost < 1.5 ms at 26 actors"
// ---------------------------------------------------------------------------

test('08 §11 step 6 | pose + skeleton cost < 1.5 ms at 26 actors (with proof-of-work: bones actually written)', () => {
  const ACTOR_COUNT = 26; // 08 §9.4's own reference count
  const rig = createSkeleton('humanoid');
  const states = [];
  for (let i = 0; i < ACTOR_COUNT; i++) states.push(createAnimatorState(rig));

  const inputs = states.map((_, i) => ({
    speed: ARCHETYPE_SPEEDS.bone_ranker.run * (0.4 + 0.6 * ((i % 5) / 4)), // vary speed per actor, like a real pack
  }));

  function poseAllActors() {
    let bonesWritten = 0;
    for (let i = 0; i < ACTOR_COUNT; i++) {
      const result = updateAnimator(states[i], inputs[i], DT);
      bonesWritten += result.bonesWritten;
    }
    return bonesWritten;
  }

  // Warm up (JIT settling) — not timed.
  for (let i = 0; i < 60; i++) poseAllActors();

  // Median over several trials — the budget (1.5ms) has enormous headroom
  // over the measured cost here, so this is about robustness to scheduler
  // noise, not chasing a tight margin.
  const TRIALS = 21;
  const samples = [];
  let lastBonesWritten = 0;
  for (let t = 0; t < TRIALS; t++) {
    const start = process.hrtime.bigint();
    lastBonesWritten = poseAllActors();
    const end = process.hrtime.bigint();
    samples.push(Number(end - start) / 1e6); // ms
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(TRIALS / 2)];

  console.log(`[08 §11 step 6] pose+skeleton cost @ ${ACTOR_COUNT} actors: median=${median.toFixed(4)} ms ` +
    `(min=${samples[0].toFixed(4)}, max=${samples[TRIALS - 1].toFixed(4)}) over ${TRIALS} trials; ` +
    `bonesWritten=${lastBonesWritten} (expected ${ACTOR_COUNT * rig.boneCount})`);

  // Proof of work (rule 12) — a regression that bailed early (e.g. a node/
  // actor ceiling, per M1's NAV-2 precedent cited in the ticket brief) would
  // read fast for the wrong reason; this catches it independently of the
  // timing number.
  assert.equal(lastBonesWritten, ACTOR_COUNT * rig.boneCount,
    `expected every one of ${ACTOR_COUNT} actors' ${rig.boneCount} bones to be posed every call — ` +
    `a fast-but-wrong number here would mean the timing budget passed by skipping work, not by being fast`);

  assert.ok(median < 1.5, `pose + skeleton cost at ${ACTOR_COUNT} actors must be < 1.5 ms (median); got ${median.toFixed(4)} ms`);
});
