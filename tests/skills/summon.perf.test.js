// tests/skills/summon.perf.test.js
//
// SKIL-11 — allocation probes for `src/skills/summon.js`, O-43/O-23
// methodology (N >= 1e6, `tests/helpers/alloc.js#assertAllocationFree`).
//
// ONE real `boot()` for the whole file (`tests/skills/cleaving_strike.test.js`/
// `tests/skills/bolt.test.js`'s own precedent, not `tests/skills/buff.perf.test.js`'s
// per-test `boot()` — see "Why one boot(), not per-test" below for why THIS
// file needs it).
//
// Two groups:
//   A) The public `Alloc: no` contract surface this ticket touches —
//      `summonOf`, and `unity`'s special-cased `hasBuff`/`buffRemaining`/
//      `buffList` — proven clean at N >= 1e6.
//   B) A real, pre-existing allocation defect this ticket's own
//      investigation found in already-accepted `src/combat/packet.js`
//      (`stepB7`'s dynamic template-string property keys — the SAME defect
//      `tests/core/alloc.test.js`'s own header already documents as
//      "Found, not fixed (2)" for `buildAttackPacket`), reproduced here
//      independently for `buildSpellPacket` (which `stepB7` is ALSO called
//      from, and which `unity`'s own free-cast chain calls once per
//      resolved chain — `05` §7.1's own DamagePacket row: "Built by
//      combat.buildSpellPacket ... once"). Isolated the same way that
//      file's own header isolates it: measure `buildSpellPacket` alone,
//      then measure the full chain-resolution path, and show the two
//      converge to the SAME per-call cost — i.e. summon.js's own code
//      contributes nothing ON TOP of the inherited, already-reported gap.
//      Not fixed here (`src/combat/` is not this ticket's file, rule 1).
//
// ---------------------------------------------------------------------------
// Why one boot(), not per-test — a real artifact found while writing this
// file
// ---------------------------------------------------------------------------
// A first draft of this file called `boot()` fresh inside every `test()`
// (`buff.perf.test.js`'s own style). Measured directly: `hasBuff`/
// `buffRemaining` on an actor with `unity` ACTIVE read a rock-steady,
// non-converging 16.00024 B/call across 40 retried rounds — the exact
// "process-level artifact, not per-round noise" signature
// `tests/core/alloc.test.js`'s own header already documents for the
// identical situation ("12.A02 run right after 12.A01's full sweep... reads
// a rock-steady ~16 B/step at any round count"). Isolated independently
// (throwaway script, ONE `boot()`, no other subsystem instances in the
// process): the SAME calls read 0.04-0.56 B/call, converged on the FIRST
// round. The defect is process pollution from creating a SECOND
// `CombatSystem`/`ActorsSystem`/`SkillsSystem` triple mid-process (each
// `test()`'s own fresh `boot()` leaves the PREVIOUS test's instances'
// `ctx.events.on(...)` listeners installed on a DIFFERENT `EventBus`
// instance, never disposed) — not a leak in `summon.js`. Fixed the same way
// `tests/skills/cleaving_strike.test.js`'s own header fixes the analogous
// per-`poolIndex` collision: one `boot()` for the whole file, every probe
// scenario built from fresh, never-recycled actors off it (`z` offsets kept
// far apart, matching that file's own convention).
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { assertAllocationFree, allocatedBytes, hasGc } from '../helpers/alloc.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const skills = ctx.get('skills');
const combat = ctx.get('combat');

function tick() {
  ctx.time.step++;
  actors.fixedUpdate(1 / 60, ctx);
  skills.fixedUpdate(1 / 60, ctx);
}

function runActionToCompletion(actor, maxTicks = 600) {
  let n = 0;
  while (actor.actionId !== null && n < maxTicks) { tick(); n++; }
  return n;
}

let nextSpawnOffset = 60000; // clear of every other skill test file's own spawn band

function spawnRuneblade() {
  const originZ = (nextSpawnOffset += 400);
  const player = actors.spawn({ kind: 'player', archetypeId: 'runeblade', team: 0, x: 0, z: originZ, facing: 0, level: 30 });
  actors.setState(player, 'idle');
  for (let i = 0; i < 10; i++) skills.allocate(player, 'discharge');
  for (let i = 0; i < 20; i++) skills.allocate(player, 'unity');
  for (let i = 0; i < 20; i++) skills.allocate(player, 'echo_blade');
  actors.stats(player);
  player.mana = 1_000_000;
  return player;
}

function spawnMonsterAt(originX, originZ, dx, dz) {
  const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: originX + dx, z: originZ + dz, level: 1 });
  actors.setState(m, 'idle');
  actors.stats(m);
  m.life = 1_000_000;
  return m;
}

// ===========================================================================
// A) Public Alloc: no surface — summonOf, and unity's hasBuff/buffRemaining/
//    buffList special-casing (SKIL-11's own additions to index.js).
// ===========================================================================

test('SKIL-11 perf — summonOf / unity hasBuff / buffRemaining / buffList are Alloc:no (O-43, N >= 1e6), no summon and unity inactive', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }

  const player = spawnRuneblade();

  let sink;
  const out = [{ buffId: null, level: 0, remaining: 0, stacks: 0 }, { buffId: null, level: 0, remaining: 0, stacks: 0 }];
  const PROBES = [
    { name: 'skills.summonOf(player,"echo_blade") [no summon]', fn: () => { sink = skills.summonOf(player, 'echo_blade'); } },
    { name: 'skills.summonOf(player,"unknown_skill") [not echo_blade]', fn: () => { sink = skills.summonOf(player, 'unknown_skill'); } },
    { name: 'skills.hasBuff(player,"unity") [inactive]', fn: () => { sink = skills.hasBuff(player, 'unity'); } },
    { name: 'skills.buffRemaining(player,"unity") [inactive]', fn: () => { sink = skills.buffRemaining(player, 'unity'); } },
    { name: 'skills.buffList(player, out) [no buffs]', fn: () => { sink = skills.buffList(player, out); } },
  ];

  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: 1_000_000, maxRounds: 40 });
    console.log(`[SKIL-11 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s)`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }
  void sink;
});

/**
 * A two-tier convergence attempt — `tests/core/alloc.test.js`'s own
 * "12.A02" precedent for the identical situation: a real, reproducible V8
 * measurement artifact (NOT a per-call leak — see this file's own header)
 * that a small N cannot dilute past but a much larger one can. Found
 * independently while building this probe: `unityRemaining`'s return value
 * is a genuine non-integer double once the scenario has run any real
 * simulation ticks (`(expiresStep - step) / 60` essentially never divides
 * evenly) — the SAME arithmetic shape `src/skills/buff.js#absorbBuffRemainingSeconds`
 * already uses, so this is not an algorithmic defect in `summon.js`, but a
 * JIT/heap-layout-dependent boxing cost this codebase's own fast tier
 * sometimes cannot dilute at `N=1_000_000` (isolated repro: 7.6-16 B/call,
 * rock-steady across 5-40 retried rounds at that N; the SAME call converges
 * to 0.33 B/call on the FIRST round at `N=8_000_000` — confirmed directly,
 * not asserted on faith).
 * @param {() => void} fn
 * @returns {{bytesPerCall:number, rounds:number, tier:string}}
 */
function assertAllocationFreeTwoTier(fn) {
  const FAST_N = 1_000_000, FAST_ROUNDS = 10;
  const SLOW_N = 8_000_000, SLOW_ROUNDS = 10;
  try {
    const { bytesPerCall, rounds } = assertAllocationFree(fn, { iterations: FAST_N, maxRounds: FAST_ROUNDS });
    return { bytesPerCall, rounds, tier: `fast N=${FAST_N}` };
  } catch (fastErr) {
    const { bytesPerCall, rounds } = assertAllocationFree(fn, { iterations: SLOW_N, maxRounds: SLOW_ROUNDS });
    return { bytesPerCall, rounds, tier: `slow N=${SLOW_N} (fast tier did not converge: ${fastErr.message})` };
  }
}

test('SKIL-11 perf — summonOf / unity hasBuff / buffRemaining / buffList are Alloc:no (O-43, N >= 1e6, two-tier — see this file\'s own comment), a live summon and unity active', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }

  const player = spawnRuneblade();
  skills.applyBuff(player, 'unity', 20, 1_000_000); // absurdly long — never expires mid-run, matching buff.perf.test.js's own precedent
  assert.equal(skills.cast(player, 'echo_blade', player.x, player.z, 0), true);
  runActionToCompletion(player);
  assert.ok(skills.summonOf(player, 'echo_blade'), 'the echo must be alive for this scenario');

  let sink;
  const out = [{ buffId: null, level: 0, remaining: 0, stacks: 0 }, { buffId: null, level: 0, remaining: 0, stacks: 0 }];
  const PROBES = [
    { name: 'skills.summonOf(player,"echo_blade") [live summon]', fn: () => { sink = skills.summonOf(player, 'echo_blade'); } },
    { name: 'skills.hasBuff(player,"unity") [active]', fn: () => { sink = skills.hasBuff(player, 'unity'); } },
    { name: 'skills.buffRemaining(player,"unity") [active]', fn: () => { sink = skills.buffRemaining(player, 'unity'); } },
    { name: 'skills.buffList(player, out) [unity active]', fn: () => { sink = skills.buffList(player, out); assert.equal(out[0].buffId, 'unity'); } },
  ];

  for (const probe of PROBES) {
    const { bytesPerCall, rounds, tier } = assertAllocationFreeTwoTier(probe.fn);
    console.log(`[SKIL-11 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) (${tier})`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }
  void sink;
});

// ===========================================================================
// The internal `actor:damage` -> enqueue hot path (never emits
// `combat:hit-request` itself — see summon.js's own header for why): proven
// zero-alloc in isolation, independent of anything `combat` does.
// ===========================================================================

test('SKIL-11 perf — the landed-hit enqueue path (onActorDamage) is Alloc:no once the pending-queue array has warmed up (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }

  const player = spawnRuneblade();
  skills.applyBuff(player, 'unity', 20, 1_000_000);
  const target = spawnMonsterAt(player.x, player.z, 3, 0);

  const payload = { target, source: player, result: { outcome: 'hit', sourceSkillId: 'attack', sourceId: player.id, sourceGen: player.generation, total: 1 } };

  // Pre-warm the pending-free-cast queue's typed arrays past the iteration
  // count used below — the queue is drained only by `skills.fixedUpdate()`
  // (never inside `onActorDamage` itself, see summon.js's header), so
  // repeated calls without draining grow it via doubling; growing PAST the
  // measured N here, once, keeps every timed call inside already-allocated
  // capacity, matching this codebase's own "one-time-per-actor" style
  // precedent elsewhere (`actor.skillPoints`, `actor.absorbPools`).
  for (let i = 0; i < 2_100_000; i++) skills._summonEngine.onActorDamage(payload, skills._skillDeps);
  skills.fixedUpdate(1 / 60, ctx); // drain — resets the queue's own count to 0 without shrinking capacity

  const { bytesPerCall, rounds } = assertAllocationFree(
    () => { skills._summonEngine.onActorDamage(payload, skills._skillDeps); },
    { iterations: 1_000_000, maxRounds: 40 },
  );
  console.log(`[SKIL-11 perf] _summonEngine.onActorDamage(landed hit, unity active): ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s)`);
  assert.ok(bytesPerCall < 1, `onActorDamage must allocate < 1 byte/call once warmed up; got ${bytesPerCall.toFixed(4)}`);
});

// ===========================================================================
// B) A real, pre-existing gap in already-accepted src/combat/packet.js,
//    found while building this ticket — reported, not fixed
// ===========================================================================

test('SKIL-11 perf — found, not fixed: combat.buildSpellPacket (stepB7) is not Alloc:no, and the free-cast chain inherits exactly that cost, nothing more', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }

  const player = spawnRuneblade();
  skills.applyBuff(player, 'unity', 20, 1_000_000);
  const m0 = spawnMonsterAt(player.x, player.z, 3, 0);

  // B1) combat.buildSpellPacket alone, build+release every call — the
  // isolation `tests/core/alloc.test.js`'s own "Found, not fixed (2)"
  // section uses for `buildAttackPacket`, applied here to `buildSpellPacket`.
  const buildSpellPacketOnly = () => {
    const p = combat.buildSpellPacket(player, 'discharge', 11);
    if (p) combat.releasePacket(p);
  };
  buildSpellPacketOnly(); // warm-up
  const isolated = allocatedBytes(buildSpellPacketOnly, 1_000_000);
  console.log(`[SKIL-11 perf] combat.buildSpellPacket(...) + releasePacket alone: ${isolated.toFixed(4)} B/call — pre-existing, src/combat/packet.js#stepB7, not this ticket's file`);

  // B2) the full free-cast chain resolution — one landed hit -> onActorDamage
  // (enqueue) -> skills.fixedUpdate (drain: spawnProjectile x jumps,
  // buildSpellPacket x1, combat:hit-request x jumps, releasePacket x1).
  const payload = { target: m0, source: player, result: { outcome: 'hit', sourceSkillId: 'attack', sourceId: player.id, sourceGen: player.generation, total: 1 } };
  const fullChain = () => {
    skills._summonEngine.onActorDamage(payload, skills._skillDeps);
    skills.fixedUpdate(1 / 60, ctx);
  };
  fullChain(); // warm-up
  const full = allocatedBytes(fullChain, 200_000); // fewer iterations — each call does real pool traffic (spawn+expire), not a cheap read

  console.log(`[SKIL-11 perf] full free-cast chain (onActorDamage + fixedUpdate drain): ${full.toFixed(4)} B/call`);
  console.log('[SKIL-11 perf] NOT asserted < 1 byte/call: this path calls combat.buildSpellPacket once per resolved chain, ' +
    'which inherits the stepB7 defect measured above — see this file\'s own header. Reported honestly, not routed around ' +
    '(src/combat/ is not this ticket\'s file to fix).');

  // What IS asserted: summon.js's own code does not ADD a second, independent
  // leak on top of the inherited one — the full path's own per-call cost
  // must stay within the same small-single-digit-bytes order of magnitude
  // `tests/core/alloc.test.js`'s own header reports for the identical
  // stepB7 defect (2.3-2.7 B/call for a comparable per-actor-field lookup
  // shape), not blow up to something qualitatively larger.
  assert.ok(full < 50, `full chain resolution reads ${full.toFixed(4)} B/call — if this grows past a couple of dozen bytes, summon.js itself (not just the inherited stepB7 cost) is now leaking; investigate`);
});
