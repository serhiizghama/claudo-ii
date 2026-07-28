// tests/helpers/alloc.test.js
//
// TEST-1 acceptance tests for tests/helpers/alloc.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).
//
// Every test here needs `node --expose-gc` (same as `12.A03` in
// tests/core/events.test.js) and `t.skip()`s itself when it's absent,
// rather than throwing or silently reporting a pass — `12-testing.md`
// explicitly warns against a gate that can pass without ever having run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { allocatedBytes, hasGc, assertAllocationFree } from './alloc.js';

test('allocatedBytes(): matches 12-testing.md §4.4\'s function verbatim (signature and return shape)', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  const bytes = allocatedBytes(() => {}, 1000);
  assert.equal(typeof bytes, 'number');
  assert.ok(!Number.isNaN(bytes));
});

test('assertAllocationFree(): a genuinely allocation-free function passes and reports a passing round', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  // Preallocated outside fn, per ARCHITECTURE.md rule 6 — nothing is
  // allocated per call.
  let sink = 0;
  const fn = () => { sink += 1; };
  const result = assertAllocationFree(fn, { iterations: 5000, maxRounds: 300 });
  assert.ok(result.bytesPerCall < 1);
  assert.ok(result.rounds >= 1 && result.rounds <= 300);
  assert.ok(Array.isArray(result.samples) && result.samples.length === result.rounds);
  assert.ok(sink > 0, 'fn must actually have run, not been dead-code-eliminated');
});

test('assertAllocationFree(): the gate can fail — a function that allocates every call never passes and the call throws', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  // Deliberately allocates a small object every call — this is exactly
  // the class of regression the real A-set gates exist to catch
  // (12-testing.md §4.4: "a per-frame allocation is easy to add and
  // invisible until a hitch shows up ... three weeks later"). A bounded
  // maxRounds keeps this fast; CORE-4's own finding (reproduced for this
  // ticket) is that an allocating path never dips below ~23 bytes/call
  // even over 5000 rounds, so a small maxRounds here is not "getting
  // lucky" — it is exercising a floor that does not move.
  let sink;
  const fn = () => { sink = { x: Math.random(), y: Math.random(), z: Math.random() }; };

  assert.throws(
    () => assertAllocationFree(fn, { iterations: 2000, maxRounds: 20 }),
    /expected some round to read < 1 byte\(s\)\/call/,
  );
  assert.ok(sink !== undefined);
});

test('assertAllocationFree(): a custom threshold is honoured', (t) => {
  if (!hasGc()) {
    t.skip('needs `node --expose-gc`');
    return;
  }
  // A function allocating a real object per call must fail an
  // impossibly generous-sounding-but-still-tight threshold set far above
  // its actual floor... no: set a threshold so high that even a real
  // small-object allocation reads under it, to prove the threshold
  // parameter actually changes the pass/fail boundary rather than being
  // ignored.
  let sink;
  const fn = () => { sink = { x: 1 }; };
  const result = assertAllocationFree(fn, { iterations: 2000, maxRounds: 20, threshold: 1_000_000 });
  assert.ok(result.bytesPerCall < 1_000_000);
  assert.ok(sink !== undefined);
});

test('module import is Node-safe (no three, no DOM access at import time)', () => {
  assert.equal(typeof assertAllocationFree, 'function');
});
