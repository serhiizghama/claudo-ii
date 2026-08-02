// tests/actors/actr23-expirebysource.perf.test.js
//
// ACTR-23/D-56/O-57 — allocation probe for `actors.expireBySource`
// (`02-api-contracts.md` §7 "Status effects", `Alloc: no`). O-43/O-23
// methodology. Named `.perf.test.js` per D-11.
//
// Deliberately its OWN FILE — see
// `actr23-removestatus.perf.test.js`'s header for the full reasoning
// (the shared `status.js#compactRemove` megamorphism finding this split
// avoids measuring as a false regression).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { DETERMINISTIC_SEED } from '../helpers/seed.js';

async function makeRegistryCtx() {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null,
    camera: null,
    uiScene: null,
    uiCamera: null,
    canvas: null,
    config: {},
    events,
    input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(DETERMINISTIC_SEED),
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  await registry.init(ctx);
  return ctx;
}

test('ACTR-23 perf — actors.expireBySource(actor, sourceId) allocates < 1 byte/call in isolation (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  // sourceId 999999 never matches — expireBySource always removes 0, no
  // mutation, so every iteration is identical (same discipline
  // actr22.perf.test.js's 'spend' probe uses).
  const fn = () => { void actors.expireBySource(actor, 999999); };

  const { bytesPerCall, rounds } = assertAllocationFree(fn, { iterations: 2_000_000, maxRounds: 40 });
  console.log(`[ACTR-23 perf] actors.expireBySource(actor, 999999) [unmatched, always 0, no mutation]: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=2000000`);
  assert.ok(bytesPerCall < 1, `expireBySource must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
});
