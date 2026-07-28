// tests/helpers/actor.test.js
//
// TEST-1 acceptance tests for tests/helpers/actor.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).

import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../../src/core/rng.js';
import { EventBus } from '../../src/core/events.js';
import {
  STUB_ACTOR_FIELDS,
  makeStubActor,
  resetStubActorIds,
  makeStubGroundItem,
  resetStubItemUids,
  makeStubTime,
  makeStubCtx,
} from './actor.js';

test('makeStubActor(): carries exactly the ten fields hash.js needs per 12-testing.md §7, nothing else by default', () => {
  const actor = makeStubActor();
  assert.deepEqual(Object.keys(actor).sort(), [...STUB_ACTOR_FIELDS].sort());
});

test('makeStubActor(): the three numeric resource fields (rage/resonance/stamina) default to 0, standing in for §7\'s "secondary" slot', () => {
  // 01-data-model.md §2 has no field literally named `secondary` — that
  // string lives on the class archetype record (§2.3) and only says which
  // of these three numeric fields is "the" secondary resource for a given
  // class. This stub carries all three, regardless of class, so the hash
  // never has to guess which one is active.
  const actor = makeStubActor();
  assert.equal(actor.rage, 0);
  assert.equal(actor.resonance, 0);
  assert.equal(actor.stamina, 0);
  assert.ok(!('secondary' in actor), 'no literal `secondary` field should be present');
});

test('makeStubActor(): ids auto-increment and resetStubActorIds() rewinds them', () => {
  resetStubActorIds();
  const a = makeStubActor();
  const b = makeStubActor();
  assert.equal(b.id, a.id + 1);

  resetStubActorIds(100);
  const c = makeStubActor();
  assert.equal(c.id, 100);
});

test('makeStubActor(): overrides win over defaults, and unset fields keep their default', () => {
  const actor = makeStubActor({ life: 1, state: 'dead' });
  assert.equal(actor.life, 1);
  assert.equal(actor.state, 'dead');
  assert.equal(actor.mana, 100); // untouched default
});

test('makeStubGroundItem(): carries uid/x/z, and resetStubItemUids() rewinds the counter', () => {
  resetStubItemUids();
  const a = makeStubGroundItem();
  const b = makeStubGroundItem();
  assert.equal(b.uid, a.uid + 1);
  assert.deepEqual(Object.keys(a).sort(), ['uid', 'x', 'z']);

  resetStubItemUids(50);
  assert.equal(makeStubGroundItem().uid, 50);
});

test('makeStubTime(): the eight ctx.time fields ARCHITECTURE.md/engine.js define, all present', () => {
  const time = makeStubTime();
  assert.deepEqual(
    Object.keys(time).sort(),
    ['alpha', 'dt', 'elapsed', 'fixed', 'frame', 'raw', 'scale', 'step'].sort(),
  );
  // fixed-step-ready defaults
  assert.equal(time.dt, 1 / 60);
  assert.equal(time.fixed, 1 / 60);
  assert.equal(time.step, 0);
});

test('makeStubCtx(): default rng is seeded with DETERMINISTIC_SEED (matches tests/core/rng.test.js\'s reference vector)', () => {
  const ctx = makeStubCtx();
  // Same reference vector rng.test.js pins for 0x5eed1234.
  const expectedFirst = 3044329084;
  assert.equal(ctx.rng.u32(), expectedFirst);
});

test('makeStubCtx(): carries every field docs/ARCHITECTURE.md promises on ctx, and nothing extra', () => {
  const ctx = makeStubCtx();
  const expectedKeys = [
    'scene', 'camera', 'uiScene', 'uiCamera', 'canvas', 'config',
    'events', 'input', 'time', 'rng', 'get', 'peek', 'has',
  ];
  assert.deepEqual(Object.keys(ctx).sort(), expectedKeys.sort());
  assert.equal(ctx.scene, null);
  assert.equal(ctx.camera, null);
  assert.equal(ctx.uiScene, null);
  assert.equal(ctx.uiCamera, null);
  assert.equal(ctx.canvas, null);
  assert.equal(ctx.input, null);
  assert.deepEqual(ctx.config, {});
  assert.ok(ctx.events instanceof EventBus);
  assert.ok(ctx.rng instanceof Rng);
});

test('makeStubCtx(): get/peek/has mirror src/core/registry.js\'s contract against overrides.systems', () => {
  const fakeCombat = { resolve() { return 'resolved'; } };
  const ctx = makeStubCtx({ systems: { combat: fakeCombat } });

  assert.equal(ctx.has('combat'), true);
  assert.equal(ctx.has('nav'), false);
  assert.equal(ctx.get('combat'), fakeCombat);
  assert.equal(ctx.peek('combat'), fakeCombat);
  assert.equal(ctx.peek('nav'), undefined);
  assert.throws(() => ctx.get('nav'), /not in this stub's systems map/);
});

test('makeStubCtx(): overrides replace the corresponding default wholesale', () => {
  const rng = new Rng(999);
  const time = makeStubTime({ step: 7 });
  const events = new EventBus();
  const ctx = makeStubCtx({ rng, time, events, config: { q: 'low' } });
  assert.equal(ctx.rng, rng);
  assert.equal(ctx.time, time);
  assert.equal(ctx.events, events);
  assert.deepEqual(ctx.config, { q: 'low' });
});

test('module import is Node-safe (no three, no DOM access at import time)', () => {
  assert.equal(typeof makeStubCtx, 'function');
});
