// tests/actors/actr24.perf.test.js
//
// ACTR-24 — timing/allocation probes for the monster archetype path added to
// `src/actors/stats.js`. Named `.perf.test.js` per this ticket's own rule 9
// ("a test that asserts a time, an allocation or a frame goes in
// tests/actors/actr24.perf.test.js") so the runner isolates it in the
// `--test-concurrency=1` perf stage (O-85: an allocation assert flakes under
// concurrency and passes in isolation).
//
// Two things measured here:
//
//   1. composeStats' <=6us monster recompose budget (`02-api-contracts.md`
//      §7's own `stats` row), now exercised through the REAL archetype
//      branch this ticket adds — `tests/actors/stats.test.js`'s own
//      existing monster perf test (accepted, not touched here) only ever
//      runs a monster with `archetypeId: null` (no matching bestiary row),
//      so it never touches the new `if (archetype)` branch at all. This
//      file is the first probe that does.
//
//   2. O-79 — this ticket's brief asks explicitly: "you write through
//      exactly that path [setSourceLayer -> stats], and you are the first
//      ticket in five milestones with a real reason to isolate it... report
//      what you find, either way." ITEM-11's own bisection (see
//      tests/items/equipment.perf.test.js's header) measured a ~1.14
//      B/call floor for `setSourceLayer('equipment', ...)` immediately
//      followed by `stats()`, in a tight loop, on a PLAYER actor, with zero
//      `items` code in the chain — a floor purely inside `actors`' own
//      dirty -> recompose -> clean cycle. This file reproduces the EXACT
//      same protocol (N = 2,000,000, `assertAllocationFree`'s convergence
//      helper, all 90 FIELD_NAMES zeroed in the layer partial) on a MONSTER
//      actor whose composeStats recompose now runs THIS ticket's own new
//      archetype-lookup/Math.round code every single call, to see whether
//      O-79's floor is unchanged (inherited, not this ticket's own code) or
//      grows (this ticket's own regression). See the report for the
//      reading.
//
// O-43/O-23: allocation probes need N >= 1,000,000 — the mean decays toward
// 0 as N grows on genuinely allocation-free code; a real floor stays
// stable. Fixed by lengthening the warm-up, never by loosening the
// threshold.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats, setSourceLayer, markDirty, stats, COMPOSITION_STEP_COUNT, FIELD_NAMES } from '../../src/actors/stats.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

const FLOOR_ITERATIONS = 2_000_000; // O-43/O-23 — matches ITEM-11's own O-79 bisection protocol

function makeChampionRanker(poolIndex) {
  const actor = createActorRecord(poolIndex);
  actor.kind = 'monster';
  actor.classId = null;
  actor.archetypeId = 'bone_ranker';
  actor.level = 10;
  actor.rank = 'champion';
  return actor;
}

function bestPerCallNs(fn, iters, batches) {
  for (let i = 0; i < Math.min(2000, iters); i++) fn(); // warm up the JIT
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const elapsed = Number(process.hrtime.bigint() - start);
    const perCall = elapsed / iters;
    if (perCall < best) best = perCall;
  }
  return best;
}

// ---------------------------------------------------------------------------
// 1. <=6us monster recompose budget, exercised through the REAL archetype
//    branch (rank='champion' so RANK_MULT's lookup also runs every call).
// ---------------------------------------------------------------------------

test('composeStats: monster recompose through the REAL bone_ranker archetype branch <= 6us, paired with a step-count/correctness proof', () => {
  const actor = makeChampionRanker(9);
  let lastSteps = 0;
  const ns = bestPerCallNs(
    () => {
      markDirty(actor);
      lastSteps = composeStats(actor);
    },
    2000,
    20,
  );

  const us = ns / 1000;
  assert.ok(us <= 6, `archetype-branch composeStats must be <= 6us, measured ${us.toFixed(3)}us (best of 20 batches)`);

  // Paired proof-of-work, same discipline as stats.test.js's own monster
  // perf test: a fast-but-wrong result (early bail, stale value) must not
  // pass silently (rule 12 / the NAV-2 lesson).
  assert.equal(lastSteps, COMPOSITION_STEP_COUNT, 'the timed calls must still run all ten steps');
  assert.equal(actor.stats.maxLife, 351, 'the timed calls must still produce the correct champion life (03 §10.1\'s worked check)');
});

// ---------------------------------------------------------------------------
// 2. O-79 isolation — same protocol as ITEM-11's own bisection, on a
//    monster actor that runs this ticket's new archetype branch every
//    recompose, instead of a player.
// ---------------------------------------------------------------------------

test('ACTR-24 / O-79 isolation: setSourceLayer + stats() hot loop on a REAL-archetype monster actor, N=2e6', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const actor = makeChampionRanker(11);
  composeStats(actor); // one real compose first, so the archetype branch and every object shape are warm

  const layer = {};
  for (const k of FIELD_NAMES) layer[k] = 0;
  layer.cannotBeFrozen = false;

  let sink;
  const fn = () => {
    setSourceLayer(actor, 'equipment', layer);
    sink = stats(actor);
  };
  for (let i = 0; i < 50_000; i++) fn(); // warm-up, matching ITEM-11's own protocol
  const bytesPerCall = allocatedBytes(fn, FLOOR_ITERATIONS);
  void sink;

  // eslint-disable-next-line no-console
  console.log(
    `ACTR-24/O-79 monster-archetype floor (N=${FLOOR_ITERATIONS}): ${bytesPerCall.toFixed(4)} B/call ` +
      `(ITEM-11's own player-actor measurement of the same setSourceLayer->stats cycle: ~1.14 B/call)`,
  );

  // This is a REPORT, not a gate the ticket brief asks to fix: O-79 is an
  // already-accepted, pre-existing finding in a path this ticket's brief
  // explicitly says not to fix, only to isolate. The assertion below only
  // catches a NEW regression this ticket's own archetype/rank lookup code
  // might add on top of the inherited floor — a generous margin over
  // ITEM-11's own measured ~1.14 B/call, not a tight allocation-free claim.
  assert.ok(
    bytesPerCall < 50,
    `monster-archetype setSourceLayer->stats floor reads ${bytesPerCall.toFixed(4)} B/call — ` +
      `far above ITEM-11's ~1.14 B/call reference, suggesting this ticket's own code (not the inherited O-79 floor) allocates`,
  );
});
