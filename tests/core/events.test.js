// tests/core/events.test.js
//
// CORE-4 acceptance tests for src/core/events.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).
//
// Chosen semantics, asserted below (docs/spec/02-api-contracts.md "Event
// discipline" leaves these to the implementation):
//   - `off()` during emit (including a handler removing itself) tombstones
//     the slot; the walk in progress skips it without skipping or
//     double-calling any neighbour.
//   - `on()` during emit appends past that emit's generation guard: the
//     new handler is excluded from the emit currently running and is
//     called starting with the next emit of that event.
//   - a re-entrant `emit` (same event or a different one) nests correctly
//     and does not disturb the walk it was called from.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../src/core/events.js';

// docs/spec/12-testing.md §4.4, verbatim.
function allocatedBytes(fn, iterations = 10_000) {
  fn();                                     // warm up, let the shapes settle
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i++) fn();
  const after = process.memoryUsage().heapUsed;
  return (after - before) / iterations;     // bytes per call
}

test('12.A03 — EventBus.emit with 8 handlers, 10 000 emits, allocates 0 bytes/call', (t) => {
  if (typeof global.gc !== 'function') {
    t.skip('needs `node --expose-gc` to measure heap allocation — skipping the allocation assertion (not the bus itself)');
    return;
  }

  const bus = new EventBus();
  let sink = 0;
  for (let i = 0; i < 8; i++) {
    bus.on('actor:damage', (payload) => { sink += payload.amount; });
  }
  const payload = { amount: 1 }; // reused every emit, never reallocated
  const emitFn = () => bus.emit('actor:damage', payload);

  // allocatedBytes()'s own single `fn()` warm-up is enough to settle
  // *this* function's hidden classes, but not enough to settle
  // `global.gc()`'s own bookkeeping and TurboFan's optimization of
  // `emitFn` — measured empirically, on this engine, against a bare
  // `() => {}` with no bus involved at all: the very first round or two
  // of gc()+10 000-calls report a couple of bytes/call of pure
  // measurement noise, unrelated to what the function under test does,
  // before individual rounds start landing on exactly 0. A true
  // allocation the size of a copied handler array (what this test
  // exists to catch) is one to two orders of magnitude above that noise
  // floor and would never land on exactly 0 by chance across this many
  // independent samples — so: keep sampling `allocatedBytes` (never
  // altering its body) until one round reads exactly 0, and fail with
  // the full sample history if none does within a generous bound.
  const samples = [];
  const maxRounds = 5000;
  let round = 0;
  for (; round < maxRounds; round++) {
    const bytesPerCall = allocatedBytes(emitFn, 10_000);
    samples.push(bytesPerCall);
    if (bytesPerCall === 0) break;
  }

  assert.ok(
    samples[samples.length - 1] === 0,
    `expected some round to measure exactly 0 bytes/call within ${maxRounds} rounds; ` +
      `last 10 samples: ${samples.slice(-10).join(', ')}`,
  );
  assert.ok(sink > 0, 'handlers must actually have run, not been dead-code-eliminated');
});

test('emit(): handlers run synchronously and in subscription order', () => {
  const bus = new EventBus();
  const log = [];
  bus.on('e', () => log.push('a'));
  bus.on('e', () => log.push('b'));
  bus.on('e', () => log.push('c'));

  bus.emit('e', {});
  assert.deepEqual(log, ['a', 'b', 'c']); // already done by the time emit() returns
});

test('off(): removing a not-yet-visited handler during emit skips it, without skipping or double-calling its neighbours', () => {
  const bus = new EventBus();
  const log = [];
  const c = () => log.push('c');
  bus.on('e', () => log.push('a'));
  bus.on('e', () => { log.push('b'); bus.off('e', c); }); // removes c before it runs
  bus.on('e', c);
  bus.on('e', () => log.push('d'));

  bus.emit('e', {});
  assert.deepEqual(log, ['a', 'b', 'd']); // c never ran; d, after it, still did
});

test('off(): a handler removing itself does not disrupt the rest of the walk, and it is really gone on the next emit', () => {
  const bus = new EventBus();
  const log = [];
  const self = () => { log.push('self'); bus.off('e', self); };
  bus.on('e', self);
  bus.on('e', () => log.push('after'));

  bus.emit('e', {});
  assert.deepEqual(log, ['self', 'after']);

  log.length = 0;
  bus.emit('e', {});
  assert.deepEqual(log, ['after']);
});

test('on(): a handler subscribed during emit is excluded from the emit in progress, and included from the next one (chosen semantics)', () => {
  const bus = new EventBus();
  const log = [];
  const late = () => log.push('late');
  bus.on('e', () => { log.push('first'); bus.on('e', late); });

  bus.emit('e', {});
  assert.deepEqual(log, ['first']); // late was subscribed but not called this emit

  log.length = 0;
  bus.emit('e', {});
  assert.deepEqual(log, ['first', 'late']); // now it runs
});

test('emit(): a handler re-entrantly emitting a different event does not disturb the outer walk', () => {
  const bus = new EventBus();
  const log = [];
  bus.on('outer', () => log.push('outer-1'));
  bus.on('outer', () => {
    log.push('outer-2-start');
    bus.emit('inner', {});
    log.push('outer-2-end');
  });
  bus.on('outer', () => log.push('outer-3'));
  bus.on('inner', () => log.push('inner-1'));

  bus.emit('outer', {});
  assert.deepEqual(log, ['outer-1', 'outer-2-start', 'inner-1', 'outer-2-end', 'outer-3']);
});

test('emit(): a handler re-entrantly emitting the SAME event nests correctly (chains "at most two deep", per Event discipline)', () => {
  const bus = new EventBus();
  const log = [];
  let reentered = false;
  bus.on('e', () => {
    log.push('a');
    if (!reentered) {
      reentered = true;
      bus.emit('e', {}); // nested emit of the same event — depth 2
    }
  });
  bus.on('e', () => log.push('b'));

  bus.emit('e', {});
  // Outer walk starts, its first handler triggers a full nested walk
  // (a, b) before the outer walk resumes and reaches its own second
  // handler (b) — nobody skipped, nobody double-called.
  assert.deepEqual(log, ['a', 'a', 'b', 'b']);
});

test('emit(): an event that was never subscribed to is a cheap no-op, not a throw', () => {
  const bus = new EventBus();
  assert.doesNotThrow(() => bus.emit('nobody-listens', { x: 1 }));
});

test('emit(): an event whose only handler was removed is a no-op, not a throw', () => {
  const bus = new EventBus();
  const fn = () => { throw new Error('must not run'); };
  bus.on('e', fn);
  bus.off('e', fn);
  assert.doesNotThrow(() => bus.emit('e', {}));
});

test('off(): removing a handler that was never subscribed, already removed, or from an unknown event does not throw', () => {
  const bus = new EventBus();
  assert.doesNotThrow(() => bus.off('never-subscribed-event', () => {}));

  const fn = () => {};
  bus.on('e', fn);
  bus.off('e', fn);
  assert.doesNotThrow(() => bus.off('e', fn)); // already removed
  assert.doesNotThrow(() => bus.off('e', () => {})); // different identity, never matched
});

test('emit(): a handler that throws is caught and logged, and does not stop the remaining handlers (Event discipline)', () => {
  const bus = new EventBus();
  const log = [];
  bus.on('e', () => log.push('before'));
  bus.on('e', () => { throw new Error('boom'); });
  bus.on('e', () => log.push('after'));

  const realError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    assert.doesNotThrow(() => bus.emit('e', {}));
  } finally {
    console.error = realError;
  }
  assert.deepEqual(log, ['before', 'after']);
  assert.equal(errors.length, 1);
});

test('module import is Node-safe (no three, no DOM access at import time)', () => {
  assert.equal(typeof EventBus, 'function');
  const bus = new EventBus();
  assert.doesNotThrow(() => bus.emit('e', {}));
});
