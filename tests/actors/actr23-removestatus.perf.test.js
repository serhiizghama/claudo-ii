// tests/actors/actr23-removestatus.perf.test.js
//
// ACTR-23/D-56/O-57 — allocation probe for `actors.removeStatus`
// (`02-api-contracts.md` §7 "Status effects", `Alloc: no`). O-43/O-23
// methodology (`iterations >= 1_000_000`,
// `tests/helpers/alloc.js#assertAllocationFree`). Named `.perf.test.js` per
// D-11.
//
// Deliberately its OWN FILE, not folded into `actr23.perf.test.js` —
// `removeStatus` shares `status.js`'s internal `compactRemove(actor,
// shouldRemove)` helper with `clearStatuses` and `expireBySource`, each
// passing a differently-shaped closure. Measured directly for this ticket:
// running more than one of the three in the same warm V8 process makes
// `compactRemove`'s internal `shouldRemove(inst)` call site megamorphic,
// after which whichever of the three runs later stops eliding its closure
// allocation and settles at a stable, non-decaying ~1.4-1.5 B/call (does not
// improve even after 3,000,000 extra warm-up calls — this is not measurement
// noise `assertAllocationFree`'s sampling protocol is meant to average out).
// `node --test`'s own default (confirmed for this ticket: `node --test
// fileA.test.js fileB.test.js` gives each file its own process) makes a
// same-process reading avoidable by putting each of the three in a file of
// its own, which is what this file and its two siblings
// (`actr23-clearstatuses.perf.test.js`, `actr23-expirebysource.perf.test.js`)
// do — each gets a clean, uncontaminated V8 process, and each measures near
// 0 B/call in isolation (see the report for the actual numbers).
//
// This is a real property of `status.js#compactRemove`'s three non-hot-path
// callers, already flagged as unaddressed in that file's own header comment
// (`expireStatuses`'s section: "compactRemove's other three call sites —
// clearStatuses, expireBySource ..., removeStatus — are not in any
// fixedUpdate hot path today, so their own closures are out of this
// ticket's scope to chase"). `status.js` is not in this ticket's file list —
// reported here and in the report, not "fixed" by rewriting ACTR-10's own
// file.
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
import { STATUS } from '../../src/actors/status.js';
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

test('ACTR-23 perf — actors.removeStatus(actor, status) allocates < 1 byte/call in isolation (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  // 'blinded' is never applied — removeStatus always removes 0, no
  // mutation, so every iteration is identical (same discipline
  // actr22.perf.test.js's 'spend' probe uses).
  const fn = () => { void actors.removeStatus(actor, STATUS.blinded); };

  const { bytesPerCall, rounds } = assertAllocationFree(fn, { iterations: 2_000_000, maxRounds: 40 });
  console.log(`[ACTR-23 perf] actors.removeStatus(actor, 'blinded') [absent, always 0, no mutation]: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=2000000`);
  assert.ok(bytesPerCall < 1, `removeStatus must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
});
