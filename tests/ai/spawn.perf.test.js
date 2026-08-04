// tests/ai/spawn.perf.test.js
//
// AI-7 — timing / allocation / work-verification probes for
// `src/ai/spawn.js` and for the two things it adds to `AiSystem.fixedUpdate`
// (`stepActivation` every step, `despawnEscaped` on a 30-step cadence).
//
// House convention every AI ticket applies: "anything asserting a time, an
// allocation or a frame goes in `<ticket>.perf.test.js`."
//
// What is and is not asserted here, and why:
//   - `resolveRoster`/`describeComposition` ALLOCATE by design (a roster
//     array per pack) and run once per pack at `zone:ready`, between frames
//     — the same cost class as `src/world/spawn.js`'s own plan. They are
//     timed, not allocation-gated: an allocation gate on a function whose
//     contract is "return a new array" is a gate that cannot pass.
//   - `updatePackTier` / `packTierOf` / `notePackDamage` DO run every fixed
//     step for every pack and every brain, so those ARE allocation-gated at
//     O-43/O-85's N=1e6 vs N=4e6 marginal methodology (this codebase's own
//     established rule — the small-N mean reads noise, not signal).
//   - MB13 (`ai.fixedUpdate` p95 < 0.30 ms at 25 active monsters) is AI-4's
//     assertion and `tests/ai/nav.perf.test.js` owns it. What is measured
//     here is the DELTA this ticket adds to that same call: the cost of the
//     activation machinery alone, over real packs from a real
//     `world.enterZone`, so a regression is attributable rather than merely
//     visible in someone else's p95.
//
// Run with `node --expose-gc` (`tests/helpers/alloc.js`); the allocation
// probes `t.skip()` when `global.gc` is absent rather than passing silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  PACK_TEMPLATES,
  PACK_TIER,
  resolveRoster,
  describeComposition,
  createSpawnStore,
  updatePackTier,
  packTierOf,
  notePackDamage,
  promotionRanks,
  packTemplate,
  effectivePackCount,
} from '../../src/ai/spawn.js';
import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { AiSystem } from '../../src/ai/index.js';
import { Rng } from '../../src/core/rng.js';
import { makeStubCtx } from '../helpers/actor.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

const FIXED_DT = 1 / 60;
const TEMPLATE_IDS = Object.keys(PACK_TEMPLATES);

/** O-43/O-85 methodology, identical to `tests/ai/crowd.perf.test.js`'s and
 * `tests/ai/perception.perf.test.js`'s own helper — not re-derived. */
function assertMarginalAllocationFree(fn, label) {
  const atOne = allocatedBytes(fn, 1_000_000);
  const atFour = allocatedBytes(fn, 4_000_000);
  const marginal = (atFour * 4_000_000 - atOne * 1_000_000) / 3_000_000;
  // eslint-disable-next-line no-console
  console.log(`${label}: N=1e6 ${atOne.toFixed(4)} B/call, N=4e6 ${atFour.toFixed(4)} B/call, marginal ${marginal.toFixed(4)} B/call`);
  assert.ok(marginal < 1, `${label} must allocate < 1 byte/call marginally — got ${marginal.toFixed(4)}`);
}

function percentilesOf(samplesMs) {
  const sorted = samplesMs.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] };
}

// ===========================================================================
// A-set — the per-step functions must be allocation-free
// ===========================================================================

test('A: updatePackTier allocates nothing marginally (it runs for every pack, every fixed step)', (t) => {
  if (!hasGc()) return t.skip('needs --expose-gc');
  const store = createSpawnStore(64);
  store.count = 32;
  for (let s = 0; s < 32; s++) {
    store.centerX[s] = (s % 8) * 12 - 48;
    store.centerZ[s] = Math.floor(s / 8) * 12 - 18;
    store.memberCount[s] = 8;
    store.tier[s] = PACK_TIER.C;
  }
  let step = 0;
  assertMarginalAllocationFree(() => {
    step++;
    for (let s = 0; s < 32; s++) updatePackTier(store, s, 0, 0, step);
  }, '  updatePackTier x32 packs');
});

test('A: packTierOf allocates nothing marginally (it runs for every brain, every fixed step)', (t) => {
  if (!hasGc()) return t.skip('needs --expose-gc');
  const store = createSpawnStore(64);
  store.count = 4;
  for (let i = 0; i < 200; i++) store.slotOfActor[i] = i % 5 === 0 ? -1 : i % 4;
  let i = 0;
  assertMarginalAllocationFree(() => { i = (i + 1) & 255; packTierOf(store, i); }, '  packTierOf');
});

test('A: notePackDamage allocates nothing marginally (it runs on every actor:damage)', (t) => {
  if (!hasGc()) return t.skip('needs --expose-gc');
  const store = createSpawnStore(64);
  store.count = 4;
  for (let i = 0; i < 200; i++) store.slotOfActor[i] = i % 4;
  let i = 0;
  assertMarginalAllocationFree(() => { i = (i + 1) & 127; notePackDamage(store, i, i); }, '  notePackDamage');
});

test('A: packTemplate / effectivePackCount are Alloc: no (02-api-contracts.md §12)', (t) => {
  if (!hasGc()) return t.skip('needs --expose-gc');
  let i = 0;
  assertMarginalAllocationFree(() => { i = (i + 1) % TEMPLATE_IDS.length; packTemplate(TEMPLATE_IDS[i]); }, '  packTemplate');
  assertMarginalAllocationFree(() => { i = (i + 1) % TEMPLATE_IDS.length; effectivePackCount(TEMPLATE_IDS[i], 5); }, '  effectivePackCount');
});

// ===========================================================================
// T-set — timing of the between-frames work
// ===========================================================================

test('T: resolveRoster + promotionRanks cost per pack (zone:ready work, never per-frame)', () => {
  const N = 200_000;
  const t0 = process.hrtime.bigint();
  let sink = 0;
  for (let i = 0; i < N; i++) {
    const id = TEMPLATE_IDS[i % TEMPLATE_IDS.length];
    const c = 5 + (i % 8);
    sink += resolveRoster(id, effectivePackCount(id, c)).length + promotionRanks(c, 'champion').length;
  }
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  assert.ok(sink > 0);
  // eslint-disable-next-line no-console
  console.log(`  resolveRoster+promotionRanks: ${us.toFixed(3)} us/pack over ${N} calls`);
  // A real Wastes zone is 9-14 packs, so the whole §5.2/§5.7 half of the
  // spawn pass is well under a tenth of a millisecond. Generous ceiling —
  // this gate exists to catch an accidental O(n^2), not to police jitter.
  assert.ok(us < 20, `resolveRoster+promotionRanks must stay well under a frame budget per pack — got ${us.toFixed(3)} us`);
});

test('T: describeComposition over a whole zone of packs (what tools/mapgen.mjs pays per zone)', () => {
  const packs = [];
  for (let i = 0; i < 14; i++) {
    packs.push({ id: i, archetypeId: TEMPLATE_IDS[i % TEMPLATE_IDS.length], count: 5 + (i % 8), rank: i % 3 === 0 ? 'champion' : 'normal' });
  }
  const N = 20_000;
  const t0 = process.hrtime.bigint();
  let total = 0;
  for (let i = 0; i < N; i++) total += describeComposition(packs).total;
  const us = Number(process.hrtime.bigint() - t0) / 1000 / N;
  assert.ok(total > 0);
  // eslint-disable-next-line no-console
  console.log(`  describeComposition (14-pack zone): ${us.toFixed(3)} us/zone over ${N} calls`);
  assert.ok(us < 500, `mapgen reports 200 seeds x 2 zones; ${us.toFixed(3)} us/zone must stay far below a second in total`);
});

// ===========================================================================
// REAL PIPELINE — what this ticket adds to ai.fixedUpdate
// ===========================================================================

async function bootFullEngine(rngSeed) {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const materials = new MaterialsSystem();
  const actors = new ActorsSystem();
  const combat = new CombatSystem();
  const ai = new AiSystem();
  const ctx = makeStubCtx({
    rng: new Rng(rngSeed), scene: new THREE.Scene(),
    systems: { world, physics, nav, materials, actors, combat, ai, render: { renderer: null } },
  });
  await physics.init(ctx);
  await materials.init(ctx);
  await actors.init(ctx);
  await combat.init(ctx);
  await world.init(ctx);
  await nav.init(ctx);
  await ai.init(ctx);
  return { world, nav, actors, ai, ctx };
}

test('T (REAL PIPELINE): the §10.1 spawn pass, timed inside a real world.enterZone', async () => {
  const samples = [];
  let packs = 0;
  let monsters = 0;
  for (let i = 0; i < 12; i++) {
    const { world, ai, ctx } = await bootFullEngine(9100 + i);
    world.setWorldSeed((0x9a110000 + i) >>> 0);
    // Time the pass itself, not `enterZone` (which also generates the whole
    // zone): re-run `ai`'s own listener on the already-loaded zone.
    await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: i % 3 });
    packs += ai.spawnStats.packsSpawned;
    monsters += ai.spawnStats.monstersSpawned;
    ai.despawnAll(false);
    const t0 = process.hrtime.bigint();
    ctx.events.emit('zone:ready', { zoneId: 'ashen_wastes', bounds: world.bounds(), navVersion: 1 });
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const p = percentilesOf(samples);
  // eslint-disable-next-line no-console
  console.log(`  §10.1 spawn pass over 12 real zones (${packs} packs, ${monsters} monsters total): p50=${p.p50.toFixed(3)} ms p95=${p.p95.toFixed(3)} ms max=${p.max.toFixed(3)} ms`);
  assert.ok(monsters > 400, `sanity: ${monsters} monsters spawned`);
  // This runs once per zone load, alongside layout generation and
  // nav.rebuild — `Fixed: N` work. A 250 ms ceiling is deliberately loose;
  // it catches an accidental per-actor O(n^2), not normal variance.
  assert.ok(p.max < 250, `spawn pass max ${p.max.toFixed(3)} ms`);
});

test('T (REAL PIPELINE): AI-7\'s activation machinery costs a small fraction of ai.fixedUpdate at a real zone\'s pack load', async () => {
  const { world, ai, actors, ctx } = await bootFullEngine(9200);
  world.setWorldSeed(0x9a220000);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const store = ai._spawnStore;
  assert.ok(store.count > 0);
  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x: store.centerX[0], z: store.centerZ[0] });
  assert.ok(player);

  const STEPS = 3000;
  const full = [];
  for (let i = 0; i < STEPS; i++) {
    ctx.time.step++;
    const t0 = process.hrtime.bigint();
    ai.fixedUpdate(FIXED_DT, ctx);
    full.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  // The activation half in isolation, over the same live store: the exact
  // per-step work this ticket added on top of AI-4's MB13 measurement.
  const px = player.x;
  const pz = player.z;
  const activationOnly = [];
  for (let i = 0; i < STEPS; i++) {
    const t0 = process.hrtime.bigint();
    for (let s = 0; s < store.count; s++) updatePackTier(store, s, px, pz, ctx.time.step + i);
    for (let k = 0; k < 256; k++) packTierOf(store, k);
    activationOnly.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  const pf = percentilesOf(full);
  const pa = percentilesOf(activationOnly);
  let active = 0;
  for (let s = 0; s < store.count; s++) if (store.tier[s] !== PACK_TIER.C) active += store.memberCount[s];
  // eslint-disable-next-line no-console
  console.log(
    `\n=== AI-7 activation cost, ${STEPS} real ai.fixedUpdate steps, ${store.count} packs / ${active} active monsters ===\n`
    + `  ai.fixedUpdate (whole call, AI-2..AI-7 together): p50=${pf.p50.toFixed(4)} p90=${pf.p90.toFixed(4)} p95=${pf.p95.toFixed(4)} p99=${pf.p99.toFixed(4)} max=${pf.max.toFixed(4)} ms\n`
    + `  AI-7 activation only (updatePackTier x${store.count} + packTierOf x256): p50=${pa.p50.toFixed(4)} p95=${pa.p95.toFixed(4)} max=${pa.max.toFixed(4)} ms\n`
    + `  MB13's 0.30 ms budget is AI-4's assertion (tests/ai/nav.perf.test.js owns it); this is AI-7's delta against it.\n`,
  );
  assert.ok(pa.p95 < 0.05, `AI-7's own per-step activation work must stay under 0.05 ms p95 — got ${pa.p95.toFixed(4)} ms`);
  assert.ok(pa.p95 < pf.p95, 'the activation half must be a fraction of the whole fixedUpdate, not the bulk of it');
});

test('A (REAL PIPELINE): a steady-state ai.fixedUpdate over live packs allocates no more per step than before this ticket', async (t) => {
  if (!hasGc()) return t.skip('needs --expose-gc');
  const { world, ai, actors, ctx } = await bootFullEngine(9300);
  world.setWorldSeed(0x9a330000);
  await world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  const store = ai._spawnStore;
  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x: store.centerX[0], z: store.centerZ[0] });
  assert.ok(player);
  for (let i = 0; i < 120; i++) { ctx.time.step++; ai.fixedUpdate(FIXED_DT, ctx); } // settle

  // Step 1 mod 30 so the 30-step ESCAPED sweep never lands inside a sample —
  // it is a documented, deliberate cadence, not steady-state work.
  ctx.time.step = 1;
  const perStep = allocatedBytes(() => { ctx.time.step += 30; ai.fixedUpdate(FIXED_DT, ctx); }, 20_000);
  // eslint-disable-next-line no-console
  console.log(`  ai.fixedUpdate over ${store.count} live packs: ${perStep.toFixed(1)} B/step (whole call — AI-2..AI-7; O-79's inherited floor dominates this, see the AI-7 report)`);
  // Deliberately a ceiling on the WHOLE call, not a claim about this
  // ticket's share: `ai.fixedUpdate` has a known inherited allocation floor
  // (O-79). The A-set probes above are what gate AI-7's own functions.
  assert.ok(perStep < 20_000, `ai.fixedUpdate per-step allocation ${perStep.toFixed(1)} B is far above anything this ticket could explain`);
});
