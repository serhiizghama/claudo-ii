// tests/items/uniques_default.test.js
//
// ITEM-7 — the regression this ticket's first submission missed (orchestrator
// rejection, round 2): `src/items/roll.js`'s module-level unique-pool source
// must be the REAL, `reqLevel`-filtered table by default, not an empty stub
// that only becomes real once `ItemsSystem.init()` (or a test) calls
// `setUniquePoolSource`. A bare, headless `import './roll.js'` — exactly the
// shape `tools/lootsim.mjs` (TEST-7) uses, no `ItemsSystem` ever constructed
// — must produce real uniques with zero setup.
//
// `tests/items/uniques.test.js` could not have caught this: every one of its
// unique-producing assertions calls `setUniquePoolSource(uniquePoolAt)` first
// (the ITEM-5-established R13/R27 precedent for exercising an injectable
// hook without leaking state across tests) — which means those tests would
// pass byte-for-byte even if the shipped default were still the empty stub.
// That is exactly the O-27 family this ticket's brief warns about: a test
// that proves the setup it performed, not the shipped behaviour.
//
// This file's one test therefore does the opposite on purpose: it imports
// `roll.js` fresh — via a cache-busting query string, so the module's own
// `uniquePoolSource` variable is guaranteed to start at whatever the source
// code initialises it to, independent of whether `node:test` happens to
// isolate this file into its own process (it does today, but this assertion
// must not depend on that) or whether some other test in this same run
// already called `setUniquePoolSource` — and calls `rollItem` with NO
// `setUniquePoolSource` call anywhere in this file, before or after.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';

test('ITMS.U13 rollItem produces real uniques out of the box — a bare import of roll.js, with NO setUniquePoolSource call anywhere in this file', async () => {
  // Cache-busting specifier: forces a brand-new module instance of roll.js,
  // so its `uniquePoolSource` module-level variable is exactly the shipped
  // initialiser, untouched by any other test file/process in this run.
  const fresh = await import(`../../src/items/roll.js?fresh=${Date.now()}-${Math.random()}`);

  assert.equal(typeof fresh.setUniquePoolSource, 'function', 'sanity: this really is roll.js, not an empty module');

  const rng = new Rng(1);
  const N = 20000;
  let uniqueCount = 0;
  for (let i = 0; i < N; i++) {
    // High ilvl/rank/difficulty/magicFind — the same shape the orchestrator's
    // own repro (`wire.mjs`) used — so the unique branch is sampled often
    // enough that "0 seen" is a real signal, not sampling noise.
    const item = fresh.rollItem(i, 30, 30, 'boss', 'renunciation', 400, null, rng);
    if (item.uniqueId) uniqueCount++;
  }

  assert.ok(
    uniqueCount > 0,
    `rollItem must yield uniques with the shipped default pool source and no wiring call — got 0 of ${N} samples. ` +
      `If this fails, the module-level default in roll.js has regressed back to an empty/stub pool.`,
  );
  console.log(`  U13 bare-import sample: ${uniqueCount}/${N} items were unique, with zero setUniquePoolSource calls in this file`);
});
