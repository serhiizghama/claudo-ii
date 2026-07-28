// tests/helpers/hash.test.js
//
// TEST-1 acceptance tests for tests/helpers/hash.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../../src/core/rng.js';
import { fnv1a32, hashState, hashStateFromCtx, hashStateHex } from './hash.js';
import { makeStubActor, makeStubGroundItem, makeStubTime, resetStubActorIds, resetStubItemUids } from './actor.js';

test('fnv1a32() is a pure, deterministic function of its input string', () => {
  assert.equal(fnv1a32('hello'), fnv1a32('hello'));
  assert.notEqual(fnv1a32('hello'), fnv1a32('hellp'));
  assert.equal(fnv1a32(''), fnv1a32(''));
  // Every output is a uint32.
  for (const s of ['', 'a', 'a very much longer string with punctuation !@#$%^&*()']) {
    const v = fnv1a32(s);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 4294967296);
  }
});

test('hashState(): the same world, hashed twice, produces the same hash', () => {
  resetStubActorIds();
  resetStubItemUids();
  const world = () => ({
    actors: [makeStubActor({ x: 1, z: 2 }), makeStubActor({ x: 3, z: 4 })],
    items: [makeStubGroundItem({ x: 5 }), makeStubGroundItem({ x: 6 })],
    rngStreams: { world: new Rng(1), items: new Rng(2) },
    step: 42,
  });
  resetStubActorIds();
  resetStubItemUids();
  const a = hashState(world());
  resetStubActorIds();
  resetStubItemUids();
  const b = hashState(world());
  assert.equal(a, b);
});

test('hashState(): actor and item traversal order is canonicalized — reversing the input arrays does not change the hash', () => {
  resetStubActorIds();
  resetStubItemUids();
  const actors = [makeStubActor({ x: 1 }), makeStubActor({ x: 2 }), makeStubActor({ x: 3 })];
  const items = [makeStubGroundItem({ x: 9 }), makeStubGroundItem({ x: 8 })];
  const step = 10;

  const forward = hashState({ actors, items, step });
  const reversed = hashState({ actors: actors.slice().reverse(), items: items.slice().reverse(), step });
  assert.equal(forward, reversed);
});

test('hashState(): does not mutate the arrays it is given', () => {
  resetStubActorIds();
  const actors = [makeStubActor(), makeStubActor(), makeStubActor()];
  const idsBefore = actors.map((a) => a.id);
  hashState({ actors, step: 0 });
  assert.deepEqual(actors.map((a) => a.id), idsBefore, 'hashState reordered or mutated the input array in place');
});

test('hashState(): RNG stream name order does not change the hash, but a different stream position does', () => {
  const rngA = new Rng(100);
  const rngB = new Rng(200);
  const h1 = hashState({ rngStreams: { world: rngA, items: rngB }, step: 0 });
  const h2 = hashState({ rngStreams: { items: rngB, world: rngA }, step: 0 });
  assert.equal(h1, h2, 'key insertion order into rngStreams must not affect the hash');

  const rngAAdvanced = new Rng(100);
  rngAAdvanced.u32(); // move it one step off its start state
  const h3 = hashState({ rngStreams: { world: rngAAdvanced, items: rngB }, step: 0 });
  assert.notEqual(h1, h3, 'advancing one stream must change the hash');
});

test('hashState(): works with no actors and no items (neither subsystem exists yet)', () => {
  assert.doesNotThrow(() => hashState({ step: 0 }));
  assert.equal(hashState({ step: 0 }), hashState({ actors: [], items: [], rngStreams: {}, step: 0 }));
});

test('hashState(): a change to any one of the ten hashed actor fields changes the hash', () => {
  const base = () => makeStubActor({
    id: 1, x: 0, z: 0, life: 100, mana: 100, rage: 0, resonance: 0, stamina: 0, state: 'idle', actionSeq: 0,
  });
  const baseline = hashState({ actors: [base()], step: 0 });
  for (const [field, value] of [
    ['x', 1], ['z', 1], ['life', 99], ['mana', 99],
    ['rage', 1], ['resonance', 1], ['stamina', 1],
    ['state', 'dead'], ['actionSeq', 1],
  ]) {
    const changed = hashState({ actors: [{ ...base(), [field]: value }], step: 0 });
    assert.notEqual(changed, baseline, `changing actor.${field} did not change the hash`);
  }
});

test('hashState(): ctx.time.step changes the hash; only step is ever read off ctx.time', () => {
  const ctxA = { time: makeStubTime({ step: 5, frame: 100, alpha: 0.9, dt: 1 / 30, elapsed: 99, raw: 99, scale: 2 }) };
  const ctxB = { time: makeStubTime({ step: 5, frame: 0, alpha: 0, dt: 1 / 60, elapsed: 0, raw: 0, scale: 1 }) };
  const ctxC = { time: makeStubTime({ step: 6 }) };

  // Same step, wildly different presentation fields (frame/alpha/dt/elapsed/
  // raw/scale) -> identical hash. This is the "excluded by construction"
  // guarantee for ctx.time specifically.
  assert.equal(hashStateFromCtx(ctxA), hashStateFromCtx(ctxB));
  // Different step -> different hash.
  assert.notEqual(hashStateFromCtx(ctxA), hashStateFromCtx(ctxC));
});

test('hashState(): throws on a missing or non-integer step, before the caller can mistake it for a real hash', () => {
  assert.throws(() => hashState({}), TypeError);
  assert.throws(() => hashState({ step: 1.5 }), TypeError);
  assert.throws(() => hashState({ step: '0' }), TypeError);
  assert.throws(() => hashState({ step: NaN }), TypeError);
});

test('hashStateHex(): an 8-hex-digit, zero-padded string matching hashState()', () => {
  const hex = hashStateHex({ step: 0 });
  assert.equal(hex.length, 8);
  assert.match(hex, /^[0-9a-f]{8}$/);
  assert.equal(parseInt(hex, 16), hashState({ step: 0 }));
});

test('module import is Node-safe (no three, no DOM access at import time)', () => {
  assert.equal(typeof hashState, 'function');
});
