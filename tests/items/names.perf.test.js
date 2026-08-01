// tests/items/names.perf.test.js
//
// ITEM-8 — the ring's `Alloc: no` contract (this ticket's brief, clause 6),
// measured, not asserted by reading the source. Named `.perf.test.js` (not
// `.test.js`) per this project's convention so it lands in the isolated
// `--test-concurrency=1` perf stage (`tests/items/mods.perf.test.js` is the
// direct precedent for both the naming rule and the O-43 methodology below).
//
// O-43's methodology: allocation probes are meaningless below ~1e6
// iterations on this project's measured noise floor (a genuinely
// allocation-free function reads tens of B/call at N=1e6, settling toward
// ~0 B/call by N=4e6 — GC/JIT settling, not a leak). Sample `allocatedBytes`
// at N=1e6 and N=4e6 and judge by the MARGINAL bytes/call between the two
// totals, never by either mean alone.
//
// This file probes the RING MECHANISM ONLY — `__ring.contains`/`__ring.push`
// operate on plain integers, no string building, no object allocation —
// isolated from `rollRareName`'s own composed-name object and the two
// display strings it necessarily builds every call (inherent, accepted by
// this ticket's brief: "Composing a name is `a + ' ' + b` string
// concatenation, which necessarily allocates the result string — that is
// inherent and fine, it is not a per-frame path"). The claim under test is
// narrower and harder: the RING itself — the `Int32Array(64)` linear scan
// and the write-and-advance — allocates nothing, ever, no matter how many
// codes cycle through it. A `Map`/`Set`-backed ring would fail this probe
// (a `Map` leaks ~456 B/call on never-repeating keys per this ticket's
// brief); the `Int32Array` implementation must not.

import test from 'node:test';

import { allocatedBytes, hasGc } from '../helpers/alloc.js';
import { __ring } from '../../src/items/names.js';

test('12.ITMS-N ring push+contains allocates < 1 byte/call marginally between N=1e6 and N=4e6 (O-43 methodology)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  // Cycle through more distinct codes than the ring can ever hold (2688,
  // the full pool) so every call is a genuine "is this new code already
  // here, then evict the oldest" cycle — never a degenerate always-same-
  // code path a JIT could special-case away.
  let i = 0;
  const runOneCall = () => {
    const code = i % 2688;
    __ring.contains(code);
    __ring.push(code);
    i++;
  };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);

  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  console.log(`  ring alloc: N=1e6 ${atOneMillion.toFixed(4)} B/call, N=4e6 ${atFourMillion.toFixed(4)} B/call, marginal ${marginalBytesPerCall.toFixed(4)} B/call`);

  if (marginalBytesPerCall >= 1) {
    throw new Error(
      `the ring's push+contains must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
        `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)} B/call, N=4e6: ${atFourMillion.toFixed(4)} B/call)`,
    );
  }
});

test('12.ITMS-N2 resetRareRing (fill(0) in place) allocates < 1 byte/call marginally between N=1e6 and N=4e6', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }
  const { resetRareRing } = await import('../../src/items/names.js');
  const runOneCall = () => resetRareRing();

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);

  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  console.log(`  resetRareRing alloc: N=1e6 ${atOneMillion.toFixed(4)} B/call, N=4e6 ${atFourMillion.toFixed(4)} B/call, marginal ${marginalBytesPerCall.toFixed(4)} B/call`);

  if (marginalBytesPerCall >= 1) {
    throw new Error(
      `resetRareRing must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
        `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)} B/call, N=4e6: ${atFourMillion.toFixed(4)} B/call)`,
    );
  }
});
