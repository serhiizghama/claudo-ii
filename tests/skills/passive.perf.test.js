// tests/skills/passive.perf.test.js
//
// SKIL-5 perf acceptance: `05-skills.md` §14 row 5's own second criterion —
// "`composeStats()` stays inside the 40 µs budget with all passives at
// 20" — plus an O-79 allocation probe over the exact `setSourceLayer` ->
// `stats()` access pattern `./passive.js#computePassiveLayer` drives.
//
// `*.perf.test.js` per this ticket's own rule 9 (a test asserting a time or
// an allocation goes here) — auto-discovered by `package.json`'s
// `test:perf` glob (`find tests -name '*.perf.test.js'`), no edit to
// `package.json` needed.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Registry } from '../../src/core/registry.js';
import { EventBus } from '../../src/core/events.js';
import { Rng } from '../../src/core/rng.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { SkillsSystem } from '../../src/skills/index.js';
import { composeStats, markDirty, COMPOSITION_STEP_COUNT } from '../../src/actors/stats.js';
import { computePassiveLayer } from '../../src/skills/passive.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

async function makeCtx(seed) {
  const events = new EventBus();
  const registry = new Registry();
  const ctx = {
    scene: null, camera: null, uiScene: null, uiCamera: null, canvas: null,
    config: {}, events, input: null,
    time: { elapsed: 0, raw: 0, dt: 0, fixed: 1 / 60, alpha: 0, scale: 1, frame: 0, step: 0 },
    rng: new Rng(seed),
    get: registry.get.bind(registry),
    peek: registry.peek.bind(registry),
    has: registry.has.bind(registry),
  };
  registry.add(PhysicsSystem);
  registry.add(ActorsSystem);
  registry.add(CombatSystem);
  registry.add(SkillsSystem);
  await registry.init(ctx);
  return ctx;
}

/** Same best-of-many-batches technique `tests/actors/stats.test.js#bestPerCallNs`
 * already established for this exact 40µs gate — reproduced independently
 * here (this ticket's own file, `src/actors/stats.js`'s test is not this
 * ticket's to edit) rather than imported, since that file does not export
 * it.
 * @param {() => void} fn @param {number} iters @param {number} batches
 * @returns {number} nanoseconds/call, best batch.
 */
function bestPerCallNs(fn, iters, batches) {
  for (let i = 0; i < Math.min(2000, iters); i++) fn();
  let best = Infinity;
  for (let b = 0; b < batches; b++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const elapsed = Number(process.hrtime.bigint() - start);
    const perCall = elapsed / iters;
    if (perCall < best) best = perCall;
  }
  return best;
}

test('05.S14row5: composeStats() stays <= 40us with all eight passives at 20, and the work-done proof (step count) is checked in the same run', async () => {
  const ctx = await makeCtx(101);
  const actors = ctx.get('actors');
  const skills = ctx.get('skills');
  const actor = actors.spawn({ kind: 'player', archetypeId: 'runeblade', level: 30 });

  // All eight passive-type skills, maxed — allocate() does not validate
  // class, so this single actor legally carries every passive's own
  // contribution formula at once (the ticket's own instruction: "all
  // passives at 20"), the maximum possible sources.skills partial size.
  const passiveIds = skills.all.filter((d) => d.type === 'passive').map((d) => d.id);
  assert.equal(passiveIds.length, 8, 'sanity: eight passives, D-46');
  for (const id of passiveIds) {
    for (let i = 0; i < 20; i++) skills.allocate(actor, id);
  }
  for (const id of passiveIds) {
    assert.equal(skills.instanceOf(actor, id).allocated, 20, `${id} must be at slvl 20`);
  }

  let lastSteps = 0;
  const ns = bestPerCallNs(
    () => {
      markDirty(actor);
      lastSteps = composeStats(actor);
    },
    2000,
    20,
  );

  const us = ns / 1000;
  // eslint-disable-next-line no-console
  console.log(`composeStats() with all 8 passives @ slvl 20: ${us.toFixed(3)}us/call (best of 20 batches), ${lastSteps} composition steps run`);
  assert.ok(us <= 40, `composeStats() must stay <= 40us with all passives at 20; measured ${us.toFixed(3)}us`);

  // Work-done proof (this ticket's rule 12): the timed run did not bail
  // early. All ten composition steps every call, and the result is still
  // the real, non-degenerate maxed-passive block, not a fast-but-empty one.
  assert.equal(lastSteps, COMPOSITION_STEP_COUNT, 'a fast run that skipped a step must not pass');
  assert.ok(actor.stats.lifeSteal > 0, 'post-timing lifeSteal must still reflect bloodthirst @ 20');
  assert.ok(actor.stats.dodgeChance > 0, 'post-timing dodgeChance must still reflect shield_stance @ 20');
  assert.ok(actor.stats.maxResonance === 5, 'post-timing maxResonance must still be the resonance_circuit @ 20 cap of 5');
  assert.ok(actor.stats.manaReturnPercent > 8, 'post-timing manaReturnPercent must still be class base 8 + resonance_circuit @ 20');
});

test('O-79: computePassiveLayer -> setSourceLayer(\'skills\') -> markDirty -> stats() adds no allocation on top of the isolated actors-only floor', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const ITER = 2_000_000;

  // ── Isolation probe: setSourceLayer('skills', <zeroed>) + stats(), in the
  //    exact dirty -> recompose -> clean -> dirty cycle our own path drives
  //    — with ZERO src/skills/ code in the call chain. Reproduces
  //    tests/items/equipment.perf.test.js's own O-79 isolation technique,
  //    independently, for the 'skills' layer instead of 'equipment'. ──────
  let floorBytesPerCall;
  {
    const ctx = await makeCtx(102);
    const actors = ctx.get('actors');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'runeblade', level: 30 });
    const layer = {
      lifeSteal: 0, blockChance: 0, thorns: 0, dodgeChance: 0,
      defensePercent: 0, physicalResist: 0, fireDamagePercent: 0,
      maxMana: 0, manaRegen: 0, damageTakenToMana: 0,
      maxResonance: 0, manaReturnPercent: 0, resonanceOnHit: 0,
    };
    let sink;
    const fn = () => { actors.setSourceLayer(actor, 'skills', layer); sink = actors.stats(actor); };
    for (let i = 0; i < 50_000; i++) fn();
    floorBytesPerCall = allocatedBytes(fn, ITER);
    void sink;
  }

  // ── computePassiveLayer + setSourceLayer + markDirty + stats(), against
  //    an actor with all eight passives already at slvl 20 (steady state —
  //    the same "re-evaluate what's already allocated" call a later
  //    ticket's "passive re-evaluated" trigger would make). ──────────────
  let realBytesPerCall;
  {
    const ctx = await makeCtx(103);
    const actors = ctx.get('actors');
    const skills = ctx.get('skills');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'runeblade', level: 30 });
    const passiveIds = skills.all.filter((d) => d.type === 'passive').map((d) => d.id);
    for (const id of passiveIds) for (let i = 0; i < 20; i++) skills.allocate(actor, id);

    const passiveDefs = skills._passiveDefs;
    const effectiveLevelFn = (a, id) => skills.effectiveLevel(a, id);
    const synergyBonusFn = (a, id, key) => skills.synergyBonus(a, id, key);

    let sink;
    const fn = () => {
      const partial = computePassiveLayer(actor, passiveDefs, effectiveLevelFn, synergyBonusFn);
      actors.setSourceLayer(actor, 'skills', partial);
      actors.markDirty(actor);
      sink = actors.stats(actor);
    };
    for (let i = 0; i < 50_000; i++) fn();
    realBytesPerCall = allocatedBytes(fn, ITER);
    void sink;
  }

  // eslint-disable-next-line no-console
  console.log(
    `O-79 comparison (N=${ITER}): actors-only floor=${floorBytesPerCall.toFixed(4)} B/call, ` +
      `computePassiveLayer+setSourceLayer+markDirty+stats()=${realBytesPerCall.toFixed(4)} B/call`,
  );

  // Reported honestly either way (this ticket's own brief): if the floor
  // itself reads near ~1.1 B/call, that is O-79, inherited from
  // src/actors/stats.js, not this ticket's own allocation. The claim this
  // test proves is narrower and still meaningful: SKIL-5's own code
  // (computePassiveLayer's per-actor scratch object, markDirty's extra
  // emit) adds no allocation of its own on top of whatever that floor is.
  const margin = 8;
  if (realBytesPerCall > floorBytesPerCall + margin) {
    throw new Error(
      `computePassiveLayer()+markDirty() reads ${realBytesPerCall.toFixed(4)} B/call, more than ${margin} bytes ` +
        `above the isolated actors-only floor of ${floorBytesPerCall.toFixed(4)} B/call — SKIL-5's own code now allocates.`,
    );
  }
});

test('allocate()/respec() of a PASSIVE skill add no allocation on top of what allocate()/respec() of a NON-passive skill already cost', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  // ---------------------------------------------------------------------
  // A real, pre-existing finding, isolated by bisection (same O-79/ITEM-11
  // methodology): `respec()`'s own `for...in points` loop (SKIL-1,
  // unmodified by this ticket beyond the trailing `if (refunded > 0)
  // this._syncPassiveLayer(actor)` line) already reads a small, stable
  // allocation on this Node/V8 — measured standalone (a non-passive skill,
  // never reaching `_syncPassiveLayer` at all) at ~6-7 B/call, N=1e6,
  // in isolation. `_syncPassiveLayer`/`computePassiveLayer` measured ALONE
  // (see the O-79 test above) read ~0.02-0.09 B/call. This is a
  // `src/skills/index.js#respec` finding that predates this ticket's own
  // change and is not this ticket's `for...in` loop to rewrite — reported
  // in the ticket's report, not "fixed" here by rewriting code this ticket
  // was not asked to touch. The claim THIS test proves is the narrower,
  // still-meaningful one: a PASSIVE skill's allocate()/respec() toggle
  // costs no more than a NON-PASSIVE skill's own toggle, i.e.
  // `_syncPassiveLayer` itself adds nothing on top of the pre-existing
  // floor.
  // ---------------------------------------------------------------------
  const ITER = 1_000_000;

  let nonPassiveBytesPerCall;
  {
    const ctx = await makeCtx(104);
    const actors = ctx.get('actors');
    const skills = ctx.get('skills');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 30 });
    let onOff = true;
    let sink;
    const fn = () => {
      if (onOff) sink = skills.allocate(actor, 'cleaving_strike'); // never type:'passive' — never reaches _syncPassiveLayer
      else sink = skills.respec(actor);
      onOff = !onOff;
    };
    for (let i = 0; i < 50_000; i++) fn();
    nonPassiveBytesPerCall = allocatedBytes(fn, ITER);
    void sink;
  }

  let passiveBytesPerCall;
  {
    const ctx = await makeCtx(105);
    const actors = ctx.get('actors');
    const skills = ctx.get('skills');
    const actor = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 30 });
    let onOff = true;
    let sink;
    const fn = () => {
      if (onOff) sink = skills.allocate(actor, 'bloodthirst'); // type:'passive' — drives _syncPassiveLayer on every toggle half
      else sink = skills.respec(actor);
      onOff = !onOff;
    };
    for (let i = 0; i < 50_000; i++) fn();
    passiveBytesPerCall = allocatedBytes(fn, ITER);
    void sink;
  }

  // eslint-disable-next-line no-console
  console.log(
    `allocate()/respec() toggle (N=${ITER}): non-passive floor=${nonPassiveBytesPerCall.toFixed(4)} B/call, ` +
      `passive (drives _syncPassiveLayer)=${passiveBytesPerCall.toFixed(4)} B/call`,
  );

  const margin = 4;
  if (passiveBytesPerCall > nonPassiveBytesPerCall + margin) {
    throw new Error(
      `a passive skill's allocate()/respec() toggle reads ${passiveBytesPerCall.toFixed(4)} B/call, more than ` +
        `${margin} bytes above the non-passive floor of ${nonPassiveBytesPerCall.toFixed(4)} B/call — ` +
        `_syncPassiveLayer now allocates on top of the pre-existing floor.`,
    );
  }
});
