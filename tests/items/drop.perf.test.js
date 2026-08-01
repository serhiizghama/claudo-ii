// tests/items/drop.perf.test.js
//
// ITEM-9 — the two performance-shaped acceptance clauses this ticket's
// brief calls out, both belonging in `.perf.test.js` per house convention
// (a test asserting a time or an allocation goes here, not in
// tests/items/drop.test.js):
//
//   1. `rollGold`'s `02-api-contracts.md:965` contract (`Fixed: Y, Alloc:
//      no`) — measured with the O-43 marginal-bytes-per-call methodology
//      already established by tests/items/mods.perf.test.js/
//      names.perf.test.js, not asserted by reading the source.
//   2. A full multi-profile `rollDrop` run completes under 20 s, AND every
//      profile actually ran its full sample count — the brief's own
//      warning, verbatim: "A harness that meets its budget by running
//      fewer cases does not pass." `tools/lootsim.mjs` (TEST-7) does not
//      exist yet; this is this ticket's own sampling harness, over a
//      modest profile grid, named so TEST-7 can absorb/replace it.
//
// Clock note: this file is a TEST, not `src/items/` — `Date.now()` here
// does not violate the "no wall clock in src/items/" rule (`tools/
// check-imports.mjs` only scans `src/`), and `rollDrop` itself never reads
// a clock.

import test from 'node:test';
import assert from 'node:assert/strict';

import { allocatedBytes, hasGc } from '../helpers/alloc.js';
import { Rng } from '../../src/core/rng.js';
import { rollGold, rollDrop, resetUidCounter } from '../../src/items/drop.js';
import { resetRareRing } from '../../src/items/names.js';

test('12.ITMS-G rollGold allocates < 1 byte/call marginally between N=1e6 and N=4e6 (O-43 methodology, 02:965 Alloc=no)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }
  const rng = new Rng(0xa110c);
  const ranks = ['normal', 'minion', 'champion', 'unique', 'chest', 'urn'];
  let i = 0;
  let sink = 0; // retain the result so the JIT cannot dead-code-eliminate the call
  const runOneCall = () => {
    sink += rollGold(10 + (i % 30), ranks[i % ranks.length], (i % 200), rng);
    i++;
  };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);

  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  console.log(`  rollGold alloc: N=1e6 ${atOneMillion.toFixed(4)} B/call, N=4e6 ${atFourMillion.toFixed(4)} B/call, marginal ${marginalBytesPerCall.toFixed(4)} B/call (sink=${sink})`);

  if (marginalBytesPerCall >= 1) {
    throw new Error(
      `rollGold must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
        `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)} B/call, N=4e6: ${atFourMillion.toFixed(4)} B/call)`,
    );
  }
});

test('12.ITMS-D a full multi-profile rollDrop run completes under 20s AND every profile ran its full sample count', () => {
  resetUidCounter();
  resetRareRing();

  const families = ['tc_humanoid', 'tc_swarm', 'tc_caster', 'tc_heavy'];
  const ranks = ['normal', 'minion', 'champion', 'unique'];
  const difficulties = ['instruction', 'trial', 'renunciation'];
  const mlvls = [6, 15, 27, 37]; // one per band, per 04 §7.1's own worked levels
  const SAMPLES_PER_PROFILE = 2000;

  const profiles = [];
  for (const tc of families) {
    for (const rank of ranks) {
      for (const difficulty of difficulties) {
        for (const mlvl of mlvls) {
          profiles.push({ tc, rank, difficulty, mlvl });
        }
      }
    }
  }
  assert.equal(profiles.length, families.length * ranks.length * difficulties.length * mlvls.length);

  const rng = new Rng(0xbadc0de);
  const perProfileConsumed = new Array(profiles.length).fill(0);
  let totalItems = 0;
  let totalGold = 0;

  const started = Date.now();
  for (let p = 0; p < profiles.length; p++) {
    const { tc, rank, difficulty, mlvl } = profiles[p];
    for (let i = 0; i < SAMPLES_PER_PROFILE; i++) {
      const result = rollDrop(tc, mlvl, rank, mlvl, difficulty, 0, rng);
      totalItems += result.items.length;
      totalGold += result.gold;
      perProfileConsumed[p]++; // proof this profile actually ran, not skipped
    }
  }
  const elapsedMs = Date.now() - started;

  const expectedTotalSamples = profiles.length * SAMPLES_PER_PROFILE;
  const actualTotalSamples = perProfileConsumed.reduce((a, b) => a + b, 0);

  console.log(
    `  12.ITMS-D: ${profiles.length} profiles x ${SAMPLES_PER_PROFILE} samples = ${actualTotalSamples} rollDrop calls in ${elapsedMs}ms; ` +
      `totalItems=${totalItems}, totalGold=${totalGold}`,
  );

  // The budget itself.
  assert.ok(elapsedMs < 20000, `full multi-profile run must complete under 20s, took ${elapsedMs}ms`);

  // The "work was actually done" companion the brief demands: every single
  // profile ran its full, declared sample count — never fewer.
  assert.equal(actualTotalSamples, expectedTotalSamples, 'every profile must have run its full sample count');
  for (let p = 0; p < profiles.length; p++) {
    assert.equal(perProfileConsumed[p], SAMPLES_PER_PROFILE, `profile ${p} (${JSON.stringify(profiles[p])}) must have consumed its full sample count`);
  }
  // And the samples were not degenerate no-ops: real items and real gold
  // were actually produced across the grid (nodrop-only would fail this).
  assert.ok(totalItems > 0, 'the sample grid must have produced at least one item/potion/scroll');
  assert.ok(totalGold > 0, 'the sample grid must have produced at least one gold pile');
});
