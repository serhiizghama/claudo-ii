// tests/world/wrld4.perf.test.js
//
// WRLD-4 — the allocation probe for `requestZone` (`02-api-contracts.md`
// §5: `Fixed: Y, Alloc: no` — this ticket's own rule 9: "a test that
// asserts a time, an allocation or a frame goes in
// tests/world/wrld4.perf.test.js", and O-85: probes belong in the perf
// stage, never the unit stage).
//
// Two branches, measured separately so neither contaminates the other's
// reading:
//   - the "already pending" fast-return (`state.pending` true) — the
//     realistic steady-state a caller sees while a transition is in
//     flight, exercised through the real `world.requestZone` method.
//   - the "successful latch" branch (fields actually assigned) — exercised
//     directly against `./src/world/zone.js`'s own exported
//     `requestZoneLatch`, resetting `state.pending` between iterations so
//     the probe measures ONLY the latch, never `enterZone`'s own
//     already-documented `Alloc: yes` work.
//
// O-43/O-23: allocation probes need N >= 1,000,000 — lengthened, never a
// loosened threshold.

import test from 'node:test';
import assert from 'node:assert/strict';

import { WorldSystem } from '../../src/world/index.js';
import { createZoneRequestState, requestZoneLatch } from '../../src/world/zone.js';
import { assertAllocationFree, hasGc } from '../helpers/alloc.js';

test(
  'requestZone: the "already pending" fast-return is allocation-free',
  { skip: !hasGc() && 'run with --expose-gc' },
  () => {
    const world = new WorldSystem();
    assert.equal(world.requestZone('last_bastion', 'town_start'), true); // latch once, stays pending for the whole probe

    const { bytesPerCall, rounds } = assertAllocationFree(
      () => {
        world.requestZone('ashen_wastes', 'portal_from_town');
      },
      { iterations: 1_000_000, maxRounds: 40 },
    );

    // eslint-disable-next-line no-console
    console.log(`[WRLD-4] requestZone (already pending): ${bytesPerCall} B/call over ${rounds} round(s)`);
    assert.ok(bytesPerCall < 1);
  },
);

test(
  'requestZone: the successful-latch branch (fields assigned) is allocation-free',
  { skip: !hasGc() && 'run with --expose-gc' },
  () => {
    const state = createZoneRequestState();
    // Built once, outside the probed closure — an object literal built
    // fresh on every call would attribute ITS allocation to the probe,
    // defeating the point of measuring `requestZoneLatch` alone. Read-only
    // to the function under test (see `zone.js`'s own header).
    const opts = { runIndex: 1, difficulty: 'nightmare' };

    const { bytesPerCall, rounds } = assertAllocationFree(
      () => {
        state.pending = false; // reset so every call takes the "accepted" branch
        requestZoneLatch(state, 'ashen_wastes', 'portal_from_town', opts);
      },
      { iterations: 1_000_000, maxRounds: 40 },
    );

    // eslint-disable-next-line no-console
    console.log(`[WRLD-4] requestZoneLatch (accepted): ${bytesPerCall} B/call over ${rounds} round(s)`);
    assert.ok(bytesPerCall < 1);
    assert.equal(state.zoneId, 'ashen_wastes');
  },
);
