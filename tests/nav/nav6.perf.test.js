// tests/nav/nav6.perf.test.js
//
// NAV-6 (D-58)'s own `Alloc: no` gate for `NavSystem#markHazard`
// (`02-api-contracts.md:502`) — `tests/core/alloc.test.js`'s `12.A01` work
// list says a later ticket adding a new `Alloc: no` row adds its probe to
// its OWN subsystem's `.perf.test.js`, not the shared file (see
// `tests/player/hudstate.perf.test.js` for the identical precedent this
// file matches). Named `.perf.test.js` — picked up by `test:perf`
// (`--test-concurrency=1`, isolated) and excluded from `test:unit` by name.
//
// O-43/O-23 methodology, verbatim: a probe below ~1M iterations is noise,
// not signal — this project's own measured floor is 80.45 B/call at N=10k
// decaying to 0.325 B/call at N=4M on a genuinely allocation-free function.
// Sampled at N=1e6 and N=4e6; judged by the MARGINAL bytes between the two
// TOTALS (not either mean alone), so warm-up settling at the smaller N
// cannot hide inside the reported number. Ticket rule 5: a per-call array
// or `Map` for hazard refcounting would violate this — `src/nav/index.js`
// preallocates `_hazardRefcount`/`_hazardBaseCost` once, in the constructor
// and every `rebuild()`, never inside `markHazard` itself.

import test from 'node:test';
import assert from 'node:assert/strict';

import { NavSystem } from '../../src/nav/index.js';
import { makeStubCtx } from '../helpers/actor.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

function makeStubWorld({ staticFootprints = [], current = null } = {}) {
  return { staticFootprints, current };
}

async function makeNav({ world = makeStubWorld() } = {}) {
  const ctx = makeStubCtx({ systems: { world } });
  const nav = new NavSystem();
  await nav.init(ctx);
  return { nav, ctx, world };
}

function makeZone({ zoneId = 'test_zone', halfX = 10, halfZ = 10 } = {}) {
  return { zoneId, boundsMinX: -halfX, boundsMaxX: halfX, boundsMinZ: -halfZ, boundsMaxZ: halfZ, navVersion: 0 };
}

test('12.A0x: nav.markHazard(x,z,radius,on) allocates < 1 byte/call at N >= 1e6 (O-43 methodology)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { nav } = await makeNav();
  nav.rebuild(makeZone({ halfX: 10, halfZ: 10 })); // real rasterised grid, real-sized hazard buffers

  // Register/deregister alternates every call — the real steady-state
  // usage a ground effect produces (spawn -> markHazard(true), expire ->
  // markHazard(false)) — and keeps `refcount` oscillating 0<->1 rather than
  // climbing unboundedly (which would eventually wrap a `Uint16Array` and
  // exercise a code path a real caller never hits). Coordinates vary
  // slightly across a few cells so the hot path is not a single constant
  // cell folded away by the JIT.
  let on = true;
  let tickN = 0;
  const runOneCall = () => {
    tickN = (tickN + 1) & 0x7;
    const x = (tickN % 3) - 1; // -1, 0, 1
    const z = (tickN % 5) - 2; // -2..2
    nav.markHazard(x, z, 1.5, on);
    on = !on;
  };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `nav.markHazard(x,z,radius,on) allocation (O-43): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `nav.markHazard must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
      `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
});
