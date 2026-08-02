// tests/actors/actr23.perf.test.js
//
// ACTR-23/D-56/O-57 — allocation probes for five of the eight forwarded
// `ActorsSystem` methods this ticket adds (`02-api-contracts.md` §7,
// "Action state machine": `cancelAction`, `actionProgress`; "Status
// effects": `hasStatus`, `statusStacks`, `statusRemaining` — all `Alloc:
// no`). O-43/O-23 methodology (`iterations >= 1_000_000`,
// `tests/helpers/alloc.js#assertAllocationFree`). Named `.perf.test.js` per
// D-11.
//
// The remaining three "Status effects" rows — `removeStatus`,
// `clearStatuses`, `expireBySource` — are measured in three SEPARATE files
// (`actr23-removestatus.perf.test.js`, `actr23-clearstatuses.perf.test.js`,
// `actr23-expirebysource.perf.test.js`), each getting its own `node --test`
// child process. That split is load-bearing, not stylistic — see those
// files' shared header comment for the measured reason: all three route
// through `status.js`'s shared `compactRemove(actor, shouldRemove)` helper
// with three structurally different closures, and running more than one of
// them in the same warm V8 process makes `compactRemove`'s internal
// `shouldRemove(inst)` call site megamorphic, at which point the CALLING
// closure literal (created fresh by whichever of the three ran second)
// stops being elided and genuinely heap-allocates every call — a stable
// ~1.4-1.5 B/call floor that does not decay with more warm-up (verified: it
// does not move even after 3,000,000 extra warm-up calls). This is real,
// reproducible, and already flagged as unaddressed in `status.js`'s own
// header comment (see `expireStatuses`'s section: "compactRemove's other
// three call sites — clearStatuses, expireBySource ..., removeStatus — are
// not in any fixedUpdate hot path today, so their own closures are out of
// this ticket's scope to chase"). `status.js` is not in this ticket's file
// list, so it is reported here and in the report, not "fixed" by rewriting
// `compactRemove`'s callers out from under ACTR-10's own ownership.
//
// This file measures its five methods through the REAL public surface,
// `ctx.get('actors').<method>(...)` — not the bare pure functions imported
// directly from `src/actors/action.js` / `src/actors/status.js` the way
// `tests/core/alloc.test.js`'s `12.A01` will once this ticket's eight rows
// are added there (not granted to this ticket — see the report). This file
// is this ticket's own, independent proof that the FORWARD itself — the
// method call, argument pass-through, and return — adds no allocation of
// its own, the same reasoning `tests/actors/actr22.perf.test.js`'s own
// header gives for the previous instalment of this same debt (O-57).
//
// The mutating probe below (`cancelAction`) is deliberately driven down its
// cheapest, always-no-op path (an invalid reason) so every iteration is
// byte-for-byte identical and no per-iteration reset step is needed — the
// same "amount=0, always succeeds, nothing to reset" discipline
// `actr22.perf.test.js`'s own `spend` probe already uses. The REAL
// success/mutation paths for all eight of this ticket's rows are already
// exercised by `tests/actors/actr23.test.js` (this ticket) and
// `tests/actors/action.test.js` / `tests/actors/status.test.js` (ACTR-9/10,
// pure-function level) — this file's only job is the forward's own
// allocation cost, not re-proving those paths are correct.
//
// O-79: a known, unexplained ~1.14 B/call floor exists in the
// `setSourceLayer` -> `stats` path in this same subsystem. None of these
// five forwards read `stats()` internally (`action.js#cancelAction`/
// `actionProgress` and `status.js#hasStatus`/`statusStacks`/
// `statusRemaining` all operate on `actor.state`/`actor.statuses`/
// `actor.statusMask` directly) — if any probe still lands near 1.1 rather
// than near 0, that would be a NEW finding, not the inherited floor; each
// probe's own comment says so either way once measured.
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

test('ACTR-23 perf — cancelAction/actionProgress/hasStatus/statusStacks/statusRemaining allocate < 1 byte/call (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });
  actors.setState(actor, 'idle');
  // A real, currently-held status — exercises hasStatus/statusStacks/
  // statusRemaining's real "present" branch, not just the absent one.
  actors.applyStatus(actor, { status: STATUS.slowed, step: 0, sourceId: 1, magnitude: 20, duration: 1_000_000 });

  let sink; // keeps a return-value probe from being dead-code-eliminated

  const PROBES = [
    { name: "actors.cancelAction(actor, 'nope') [invalid reason, always false, no mutation]", iterations: 2_000_000, fn: () => { sink = actors.cancelAction(actor, 'nope'); } },
    { name: 'actors.actionProgress(actor) [no action in progress, read-only]', iterations: 2_000_000, fn: () => { sink = actors.actionProgress(actor); } },
    { name: 'actors.hasStatus(actor, slowed) [bitfield test, read-only]', iterations: 2_000_000, fn: () => { sink = actors.hasStatus(actor, STATUS.slowed); } },
    { name: 'actors.statusStacks(actor, slowed) [read-only]', iterations: 2_000_000, fn: () => { sink = actors.statusStacks(actor, STATUS.slowed); } },
    { name: 'actors.statusRemaining(actor, slowed, 0) [read-only]', iterations: 2_000_000, fn: () => { sink = actors.statusRemaining(actor, STATUS.slowed, 0); } },
  ];

  const results = [];
  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: probe.iterations, maxRounds: 40 });
    results.push({ name: probe.name, bytesPerCall, rounds });
    const floorNote = bytesPerCall > 0.5
      ? ' (near the O-79 ~1.14 B/call inherited stats-path floor -- unexpected here since these forwards never touch stats(); flagging as a possible new finding)'
      : '';
    console.log(`[ACTR-23 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=${probe.iterations}${floorNote}`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }

  assert.equal(results.length, PROBES.length);
  void sink;
});
