// tests/actors/actr22.perf.test.js
//
// ACTR-22/D-52/O-57 — allocation probes for the seven forwarded
// `ActorsSystem` methods (`02-api-contracts.md` §7 "Stats and vessels",
// all `Alloc: no`): `addLife`, `addMana`, `addRage`, `addResonance`,
// `spend`, `canAfford`, `lifeFraction`. O-43/O-23 methodology
// (`iterations >= 1_000_000`, `tests/helpers/alloc.js#assertAllocationFree`
// — see that file's own header for why the spec's bare N=10 000 is not
// used directly). Named `.perf.test.js` per D-11.
//
// This file measures the seven methods through the REAL public surface,
// `ctx.get('actors').<method>(...)` — not the bare pure functions imported
// directly from `src/actors/vessels.js` the way `tests/core/alloc.test.js`'s
// `12.A01` already does. `12.A01` is not granted to this ticket (see the
// report for the exact rows requested there); this file is this ticket's
// own, independent proof that the FORWARD itself — the method call,
// argument pass-through, and return — adds no allocation of its own, so the
// claim does not rest on an edit nobody has made yet (same reasoning
// `tests/skills/cost.perf.test.js`'s own header gives for SKIL-2).
//
// O-79: a known, unexplained ~1.14 B/call floor exists in the
// `setSourceLayer` -> `stats` path in this same subsystem. `addLife`,
// `addMana`, `addRage`, `addResonance` and `lifeFraction` below all read
// `stats(actor)` internally (`vessels.js`'s own `addClamped`/`lifeFraction`)
// — if any of their probes lands near 1.1 rather than near 0, that is this
// inherited floor, not a new regression; each probe's own comment says so
// either way once measured.
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

test('ACTR-22 perf — the seven forwarded actors.<method>() calls allocate < 1 byte/call (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ctx = await makeRegistryCtx();
  const actors = ctx.get('actors');
  const actor = actors.spawn({ kind: 'monster' });

  // Compose once, untimed, so every probe below reads an already-clean
  // StatBlock — the same "compose once during setup" discipline
  // `tests/core/alloc.test.js`'s `12.A01` scenario already established.
  const block = actors.stats(actor);
  block.maxLife = 1_000_000;
  block.maxMana = 1_000_000;
  actor.life = 1_000_000;
  actor.mana = 1_000_000;

  let sink; // keeps a return-value probe from being dead-code-eliminated

  const PROBES = [
    { name: "actors.addLife(actor, 1, 0) [reset life to max after every call, never lets the clamp branch or a real delta build up]", iterations: 2_000_000, fn: () => { sink = actors.addLife(actor, 1, 0); actor.life = 1_000_000; } },
    { name: 'actors.addMana(actor, 1) [reset after every call]', iterations: 2_000_000, fn: () => { sink = actors.addMana(actor, 1); actor.mana = 1_000_000; } },
    { name: 'actors.addRage(actor, 1) [self-clamping — maxRage is small, every call is a real clamp]', iterations: 2_000_000, fn: () => { sink = actors.addRage(actor, 1); } },
    { name: 'actors.addResonance(actor, 0.1) [self-clamping]', iterations: 2_000_000, fn: () => { sink = actors.addResonance(actor, 0.1); } },
    { name: 'actors.canAfford(actor, "life", 1) [read-only]', iterations: 2_000_000, fn: () => { sink = actors.canAfford(actor, 'life', 1); } },
    { name: 'actors.spend(actor, "mana", 0) [amount=0, always succeeds, no real drain to reset]', iterations: 2_000_000, fn: () => { sink = actors.spend(actor, 'mana', 0); } },
    { name: 'actors.lifeFraction(actor) [read-only]', iterations: 2_000_000, fn: () => { sink = actors.lifeFraction(actor); } },
  ];

  const results = [];
  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: probe.iterations, maxRounds: 40 });
    results.push({ name: probe.name, bytesPerCall, rounds });
    const floorNote = bytesPerCall > 0.5
      ? ' (near the O-79 ~1.14 B/call inherited stats-path floor, not a new regression)'
      : '';
    console.log(`[ACTR-22 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=${probe.iterations}${floorNote}`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }

  assert.equal(results.length, PROBES.length);
  void sink;
});
