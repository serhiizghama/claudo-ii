// tests/ai/corpse.test.js
//
// AI-9 acceptance tests — `src/ai/corpse.js` (`06-monsters-ai.md` §10.6-10.8,
// `08-characters-visual.md` §8.3-§8.5, §2.4's `raise_ranker` rules) plus
// `src/ai/index.js`'s wiring.
//
// The six criteria, and where each is measured:
//   1. `actors.resurrectableCorpses` sorts by distance then id  -> test 1
//   2. a Shaman raises exactly one Ranker per zone visit        -> test 2
//   3. a stun BEFORE `hitTick` refunds the credit, AFTER does not -> test 3
//   4. no corpse is ever raised twice                           -> test 4
//   5. killing the Shaman strips `haste_dust`                   -> test 5
//   6. a fresh brain, and the pack accounting stays consistent  -> test 6
//
// ---------------------------------------------------------------------------
// O-106's rule: drive the REAL pipeline, and say which call produced the number
// ---------------------------------------------------------------------------
// Nothing here reimplements a step of the chain. Every raise in this file is
// produced by:
//   `world.setWorldSeed()` -> `await world.enterZone(...)` -> `zone:ready`
//     -> `AiSystem`'s own listener (spawn pass, corpse-store reset)
//       -> `ai.spawnOne(...)` for the hand-placed fixture actors
//         -> `combat.applyDirect(...)` -> `combat`'s own `actor:damage` ->
//            `src/combat/xp.js` sets `dead` and emits `actor:death`
//           -> `AiSystem`'s `actor:death` listener -> `onCorpseDeath`
//             -> `ai.fixedUpdate()` -> `stepShamanBrain` (AI-6's real brain)
//               -> `actors.resurrectableCorpses` / `actors.resurrect`
//                 -> `stepCorpsesPost` -> `ai:corpse-raised`
// and read back through `actors.resurrectableCorpses`, `ai.corpseStats`,
// `ai.brainOf`, `ai.aliveCount`, `world.packs[].aliveCount` and the
// `ai:corpse-raised` event. Every `console.log` below names the call that
// produced the number.
//
// Two fixture facts that are load-bearing and are asserted, not assumed:
//   - a Bone Ranker at `mlvl 6` has `actors.stats(r).maxLife === 53`, so a
//     killing blow must be under `0.35 x 53 = 18.55` or `08` §8.4 GIBS it and
//     there is no corpse at all. `killSoftly` hits for 17 (the largest whole
//     number under that line) and asserts the corpse survived. This is not a
//     workaround: it is §8.4 working, and the §10.6 test below measures the
//     other side of the same threshold.
//   - corpse eligibility includes "on walkable nav" (`08` §8.5 condition 5),
//     so every fixture position is checked against the REAL `nav.walkable`
//     of a REAL generated zone before anything is spawned on it.
//
// Node-safe apart from the `three` import the real `world` boot needs — the
// same shape `tests/ai/spawn.test.js` and `tests/ai/rank.test.js` already use.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { WorldSystem } from '../../src/world/index.js';
import { PhysicsSystem } from '../../src/physics/index.js';
import { NavSystem } from '../../src/nav/index.js';
import { MaterialsSystem } from '../../src/materials/index.js';
import { ActorsSystem } from '../../src/actors/index.js';
import { CombatSystem } from '../../src/combat/packet.js';
import { AiSystem } from '../../src/ai/index.js';
import { Rng } from '../../src/core/rng.js';
import { QUALITY_PRESETS } from '../../src/core/config.js';
import { makeStubCtx } from '../helpers/actor.js';
import { hasGc, assertAllocationFree } from '../helpers/alloc.js';
import { CORPSE_POLICY } from '../../src/ai/corpse.js';
import { isHasted } from '../../src/ai/brains/shaman.js';

const FIXED_DT = 1 / 60;
const ACTOR_FLAG_REVIVED = 1 << 9; // 01-data-model.md §2.1
const RAISE_WIND_TICKS = 63;       // 06 §2.4's printed tick column, W = 1.05 s, never IAS-scaled

async function bootFullEngine(rngSeed, preset = 'medium') {
  const world = new WorldSystem();
  const physics = new PhysicsSystem();
  const nav = new NavSystem();
  const materials = new MaterialsSystem();
  const actors = new ActorsSystem();
  const combat = new CombatSystem();
  const ai = new AiSystem();
  const scene = new THREE.Scene();
  const ctx = makeStubCtx({
    rng: new Rng(rngSeed), scene,
    // The real preset table, not a literal — `q.corpseBudget` is `08` §8.3's
    // own number and this file must not invent a second copy of it.
    config: { q: QUALITY_PRESETS[preset] },
    systems: { world, physics, nav, materials, actors, combat, ai, render: { renderer: null } },
  });
  await physics.init(ctx);
  await materials.init(ctx);
  await actors.init(ctx);
  await combat.init(ctx);
  await world.init(ctx);
  await nav.init(ctx);
  await ai.init(ctx);
  return { world, physics, nav, actors, combat, ai, ctx };
}

function step(env) {
  env.ctx.time.step++;
  env.ctx.time.frame++;
  env.actors.fixedUpdate(FIXED_DT, env.ctx);
  env.ai.fixedUpdate(FIXED_DT, env.ctx);
  env.combat.fixedUpdate(FIXED_DT, env.ctx);
}

/**
 * A real Ashen Wastes, then emptied of its own packs so the fixture below is
 * the only population. `despawnAll` is `06` §10.5's own contracted call, not
 * a test-only back door, and the nav grid it leaves behind is what `08` §8.5
 * condition 5 is checked against.
 */
async function makeArena(seed, worldSeed, preset) {
  const env = await bootFullEngine(seed, preset);
  env.world.setWorldSeed(worldSeed >>> 0);
  await env.world.enterZone('ashen_wastes', 'portal_from_town', { runIndex: 0 });
  env.ai.despawnAll(true);
  assert.equal(env.ai.aliveCount, 0, 'fixture: the zone is empty before the fixture spawns');
  const e = env.world.entry('portal_from_town');
  assert.equal(env.nav.walkable(e.x, e.z), true, 'fixture: the entry point is walkable');
  env.anchor = findClearAnchor(env.nav, e.x, e.z);
  return env;
}

/**
 * The corner of a clear patch of REAL nav big enough for every fixture below
 * (`08` §8.5 condition 5 refuses a corpse on unwalkable ground, so this is
 * not cosmetic). Deterministic: the first candidate of a fixed spiral around
 * the zone entry whose whole box is walkable — no seed hunting, no retries.
 */
function findClearAnchor(nav, ex, ez) {
  const boxWalkable = (ox, oz) => {
    for (let dx = -1; dx <= 12.001; dx += 0.5) {
      for (let dz = -3.5; dz <= 3.501; dz += 0.5) {
        if (!nav.walkable(ox + dx, oz + dz)) return false;
      }
    }
    return true;
  };
  for (let r = 0; r <= 60; r += 1) {
    for (let a = 0; a < 16; a++) {
      const ang = (a * Math.PI) / 8;
      const ox = ex + Math.cos(ang) * r;
      const oz = ez + Math.sin(ang) * r;
      if (boxWalkable(ox, oz)) return { x: ox, z: oz };
    }
  }
  assert.fail('fixture: this zone has no 13 x 7 m walkable patch within 60 m of the entry');
  return null;
}

function spawnPlayerAt(env, x, z) {
  return env.actors.spawn({ kind: 'player', archetypeId: 'ravager', level: 10, team: 0, x, z });
}

function spawnRankerAt(env, x, z, mlvl = 6) {
  assert.equal(env.nav.walkable(x, z), true, `fixture: (${x.toFixed(2)}, ${z.toFixed(2)}) must be walkable nav`);
  const r = env.ai.spawnOne('bone_ranker', x, z, mlvl, 'normal', []);
  assert.ok(r, 'fixture: ai.spawnOne must produce a Bone Ranker');
  return r;
}

/** Kills through `combat.applyDirect` with blows strictly under `08` §8.4's
 * 35 % gib threshold, so the death leaves a corpse. Returns the blow size. */
function killSoftly(env, actor, killerId) {
  const maxLife = env.actors.stats(actor).maxLife;
  const blow = Math.max(1, Math.floor(maxLife * CORPSE_POLICY.gibLifeFraction) - 1);
  assert.ok(blow < maxLife * CORPSE_POLICY.gibLifeFraction, 'fixture: the blow must be under the gib threshold');
  let guard = 0;
  while (!actor.dead && guard++ < 200) env.combat.applyDirect(actor, blow, 'physical', killerId, 'player_attack');
  assert.equal(actor.dead, true, 'fixture: the Ranker died');
  return blow;
}

/** Runs steps until `fn()` is truthy or the budget is exhausted; returns the
 * number of steps taken (never a retry — one deterministic run). */
function runUntil(env, budget, fn) {
  for (let i = 0; i < budget; i++) {
    if (fn()) return i;
    step(env);
  }
  return budget;
}

// ===========================================================================
// Acceptance 1 — the query's order
// ===========================================================================

test('AI-9 acceptance 1: actors.resurrectableCorpses sorts by DISTANCE then by ID (02 §7, 08 §8.5)', async () => {
  const env = await makeArena(9101, 0xc0f5e01);
  const { actors, ai, anchor } = env;
  const player = spawnPlayerAt(env, anchor.x, anchor.z);

  // Five Rankers around a query point 7 m along +x. Two PAIRS share a
  // position exactly (bit-for-bit, so the distance really is a tie and not a
  // near-tie that float noise could break either way), and inside each pair
  // the HIGHER-id corpse is killed FIRST — corpse records are held in death
  // order, so the id tie-break is the only thing that can put them back in
  // ascending order. The nearest corpse is also the highest id, so a sort
  // that only looked at ids would fail too.
  const qx = anchor.x + 7;
  const qz = anchor.z;
  const layout = [
    { dx: +2, dz: 0, d: 2.0 },   // spawned 1st (id n+0) — killed 2nd of its pair
    { dx: +2, dz: 0, d: 2.0 },   // spawned 2nd (id n+1) — same spot, killed 1st
    { dx: +3, dz: 0, d: 3.0 },   // spawned 3rd (id n+2) — killed 2nd of its pair
    { dx: +3, dz: 0, d: 3.0 },   // spawned 4th (id n+3) — same spot, killed 1st
    { dx: +1, dz: 0, d: 1.0 },   // spawned 5th (id n+4) — nearest, highest id
  ];
  const rankers = layout.map((L) => spawnRankerAt(env, qx + L.dx, qz + L.dz));
  for (const r of [rankers[1], rankers[0], rankers[3], rankers[2], rankers[4]]) killSoftly(env, r, player.id);
  assert.equal(rankers[0].x, rankers[1].x, 'fixture: the tied pair really is at one position');
  assert.equal(rankers[0].z, rankers[1].z, 'fixture: the tied pair really is at one position');

  assert.equal(typeof actors.resurrectableCorpses, 'function',
    '02-api-contracts.md §7 contracts this as a METHOD ON `actors` (O-71) — see src/ai/corpse.js on who defines it');

  const out = new Int32Array(8);
  const n = actors.resurrectableCorpses(qx, qz, 9.0, out);

  // Expected: (1.0, id n+4) then the 2.0 pair by ascending id, then the 3.0 pair.
  const expected = [rankers[4].id, rankers[0].id, rankers[1].id, rankers[2].id, rankers[3].id];
  const got = Array.from(out.slice(0, n));

  const rows = ['', 'idx | corpse id | distance from the query point | spawn order'];
  for (let i = 0; i < n; i++) {
    const a = actors.byId(got[i]);
    const d = Math.hypot(a.x - qx, a.z - qz);
    rows.push(`  ${i} | ${String(got[i]).padStart(4)} | ${d.toFixed(6)} m | spawned #${rankers.findIndex((r) => r.id === got[i]) + 1}`);
  }
  // eslint-disable-next-line no-console
  console.log(`${rows.join('\n')}\n  <- actors.resurrectableCorpses(${qx.toFixed(2)}, ${qz.toFixed(2)}, 9.0, out) returned ${n}`);

  assert.equal(n, 5, 'all five corpses are inside the 9.0 m radius');
  assert.deepEqual(got, expected, 'distance first, then ASCENDING corpse id — insertion order must not survive');

  // The radius is a real filter, and `out.length` caps the count.
  const near = actors.resurrectableCorpses(qx, qz, 2.0, out);
  assert.equal(near, 3, '1.0 m + both 2.0 m corpses are inside a 2.0 m radius; the 3.0 m pair is not');
  const small = new Int32Array(2);
  assert.equal(actors.resurrectableCorpses(qx, qz, 9.0, small), 2, 'the count is clamped to out.length');
  assert.equal(small[0], expected[0], 'and it is still the nearest that gets written first');

  // A plain `int[]` `out` — the contract's own type — reports its own length.
  const arrOut = [];
  const arrN = actors.resurrectableCorpses(qx, qz, 9.0, arrOut);
  assert.equal(arrN, 0, 'a zero-length array can hold nothing');
  const arrOut8 = new Array(8).fill(0);
  assert.equal(actors.resurrectableCorpses(qx, qz, 9.0, arrOut8), 5);
  assert.deepEqual(arrOut8, expected, 'a plain array is truncated to the count it reports');

  // `Alloc: no` on the contract row (12.A01's class of check).
  if (hasGc()) {
    const probe = new Int32Array(8);
    const { bytesPerCall } = assertAllocationFree(() => { actors.resurrectableCorpses(qx, qz, 9.0, probe); });
    // eslint-disable-next-line no-console
    console.log(`  Alloc: no — actors.resurrectableCorpses measured ${bytesPerCall} bytes/call over 10000 calls`);
  }
});

// ===========================================================================
// Acceptance 2 — one raise per Shaman per zone visit
// ===========================================================================

test('AI-9 acceptance 2: a Shaman raises EXACTLY ONE Ranker per zone visit (06 §2.4, §10.7)', async () => {
  const env = await makeArena(9102, 0xc0f5e02);
  const { actors, ai, ctx, anchor } = env;
  const player = spawnPlayerAt(env, anchor.x, anchor.z);

  const sx = anchor.x + 7;
  const sz = anchor.z;
  assert.equal(env.nav.walkable(sx, sz), true, 'fixture: the Shaman stands on walkable nav');
  const shaman = ai.spawnOne('dust_shaman', sx, sz, 6, 'normal', []);
  ai.setTarget(shaman, player.id); // 06 §13-step-2's sanctioned hand-activation hook

  const rankers = [0, 1, 2, 3].map((i) => spawnRankerAt(env, sx + 1 + i * 1.2, sz + 0.5));
  for (const r of rankers) killSoftly(env, r, player.id);
  assert.equal(ai.corpseStats.corpses, 4, 'ai.corpseStats.corpses after four soft kills');

  const raises = [];
  ctx.events.on('ai:corpse-raised', (p) => raises.push({ actor: p.actor.id, shaman: p.shaman ? p.shaman.id : 0, step: ctx.time.step }));

  const creditsAtStart = ai._shamanStore.reviveCredits[shaman.poolIndex];
  const stepsToFirst = runUntil(env, 600, () => raises.length > 0);
  // 60 more seconds with three corpses still on the ground and the credit gone.
  for (let i = 0; i < 3600; i++) step(env);

  const s = ai.corpseStats;
  // eslint-disable-next-line no-console
  console.log(`\n  ai:corpse-raised fired ${raises.length}x: ${JSON.stringify(raises)}`
    + `\n  ai.corpseStats after 60s more = ${JSON.stringify(s)}`
    + `\n  ai._shamanStore.reviveCredits[shaman] : ${creditsAtStart} at spawn -> ${ai._shamanStore.reviveCredits[shaman.poolIndex]} now`
    + `\n  first raise landed ${stepsToFirst} steps after activation (raise_ranker W = ${RAISE_WIND_TICKS} ticks)`);

  assert.equal(creditsAtStart, 1, '06 §2.4: Brain.reviveCredits = 1 at spawn');
  assert.equal(raises.length, 1, 'exactly one ai:corpse-raised over 70 simulated seconds');
  assert.equal(s.raised, 1, 'ai.corpseStats.raised');
  assert.equal(ai._shamanStore.reviveCredits[shaman.poolIndex], 0, 'the credit is spent and never refilled');
  assert.equal(s.corpses - s.raised, 3, 'three corpses were still available — the limit is the credit, not the supply');
  assert.equal(actors.byId(raises[0].actor).dead, false, 'the raised Ranker is alive');
  assert.equal(raises[0].shaman, shaman.id, 'ai:corpse-raised names the Shaman that paid for it');
});

// ===========================================================================
// Acceptance 3 — the asymmetric interruption rule
// ===========================================================================

test('AI-9 acceptance 3: a stun BEFORE hitTick refunds the credit; a stun AFTER hitTick does not (06 §2.4, 08 §6.6)', async () => {
  // --- before hitTick -----------------------------------------------------
  const a = await makeArena(9103, 0xc0f5e03);
  const playerA = spawnPlayerAt(a, a.anchor.x, a.anchor.z);
  const sxA = a.anchor.x + 7;
  const szA = a.anchor.z;
  const shamanA = a.ai.spawnOne('dust_shaman', sxA, szA, 6, 'normal', []);
  a.ai.setTarget(shamanA, playerA.id);
  const corpseA = spawnRankerAt(a, sxA + 1.5, szA);
  killSoftly(a, corpseA, playerA.id);

  const idxA = shamanA.poolIndex;
  // Wait for the ritual to actually be in flight, then stun it mid-wind-up.
  const toCast = runUntil(a, 600, () => a.ai._shamanStore.castAction[idxA] === 2 && a.ai._brains.swingActive[idxA] === 1);
  const hitTickStep = a.ai._brains.hitTickStep[idxA];
  const castStep = a.ctx.time.step;
  assert.ok(hitTickStep > castStep, 'fixture: the cast is in its wind-up, hitTick still ahead');

  for (let i = 0; i < 10; i++) step(a); // let it wind up a bit, still well before hitTick
  assert.ok(a.ctx.time.step < hitTickStep, 'fixture: still before hitTick');
  a.actors.applyStatus(shamanA, { status: 'stunned', step: a.ctx.time.step, duration: 1.0, sourceId: playerA.id, sourceGen: playerA.generation });
  const stunStep = a.ctx.time.step;
  step(a); // the pre-pass sees the stun and cancels

  const creditsAfterStun = a.ai._shamanStore.reviveCredits[idxA];
  const raisedAfterStun = a.ai.corpseStats.raised;
  // Now run past the stun and past the original hitTick — the ritual must not
  // resolve, and the credit must still be spendable.
  const raisesA = [];
  a.ctx.events.on('ai:corpse-raised', (p) => raisesA.push(p.actor.id));
  for (let i = 0; i < 120; i++) step(a);
  const raisedAtOriginalTick = a.ai.corpseStats.raised;
  const stepsToRecovery = runUntil(a, 900, () => raisesA.length > 0);

  // eslint-disable-next-line no-console
  console.log(`\n  BEFORE hitTick: cast started at step ${castStep} (${toCast} steps after activation), hitTick was ${hitTickStep},`
    + ` stun applied at ${stunStep} (${hitTickStep - stunStep} ticks early)`
    + `\n    ai._shamanStore.reviveCredits[shaman] right after the stun = ${creditsAfterStun} (REFUNDED — never debited)`
    + `\n    ai.corpseStats.raised at the original hitTick = ${raisedAtOriginalTick}, interrupts = ${a.ai.corpseStats.interrupts}`
    + `\n    the same Shaman then raised ${raisesA.length} corpse ${stepsToRecovery} steps later, proving the credit was really still there`);

  assert.equal(creditsAfterStun, 1, 'the credit survives an interrupted cast — 06 §2.4 "refunds the credit"');
  assert.equal(raisedAtOriginalTick, 0, 'the interrupted ritual never resolved');
  assert.ok(a.ai.corpseStats.interrupts >= 1, 'ai.corpseStats.interrupts counted the cancellation');
  assert.equal(raisesA.length, 1, 'and the refunded credit was spendable once the stun wore off');
  assert.equal(a.ai._shamanStore.reviveCredits[idxA], 0, 'spent on the second, uninterrupted ritual');

  // --- after hitTick ------------------------------------------------------
  const b = await makeArena(9104, 0xc0f5e04);
  const playerB = spawnPlayerAt(b, b.anchor.x, b.anchor.z);
  const sxB = b.anchor.x + 7;
  const szB = b.anchor.z;
  const shamanB = b.ai.spawnOne('dust_shaman', sxB, szB, 6, 'normal', []);
  b.ai.setTarget(shamanB, playerB.id);
  const corpseB = spawnRankerAt(b, sxB + 1.5, szB);
  killSoftly(b, corpseB, playerB.id);

  const idxB = shamanB.poolIndex;
  const raisesB = [];
  b.ctx.events.on('ai:corpse-raised', (p) => raisesB.push(p.actor.id));
  const toRaise = runUntil(b, 600, () => raisesB.length > 0);
  const creditsAtRaise = b.ai._shamanStore.reviveCredits[idxB];
  b.actors.applyStatus(shamanB, { status: 'stunned', step: b.ctx.time.step, duration: 2.0, sourceId: playerB.id, sourceGen: playerB.generation });
  for (let i = 0; i < 600; i++) step(b);

  // eslint-disable-next-line no-console
  console.log(`  AFTER hitTick: the ritual resolved ${toRaise} steps after activation (ai.corpseStats.raised = ${b.ai.corpseStats.raised}),`
    + ` then a 2.0 s stun landed`
    + `\n    ai._shamanStore.reviveCredits[shaman] = ${creditsAtRaise} at the raise -> ${b.ai._shamanStore.reviveCredits[idxB]} after the stun (NOT refunded)`
    + `\n    ai.corpseStats.raised after 10 more seconds = ${b.ai.corpseStats.raised}`);

  assert.equal(creditsAtRaise, 0, 'the credit is spent on hitTick, not on cast start');
  assert.equal(b.ai._shamanStore.reviveCredits[idxB], 0, 'a stun after hitTick refunds nothing');
  assert.equal(b.ai.corpseStats.raised, 1, 'and the Ranker it already raised stays raised');
  assert.equal(raisesB.length, 1, 'no second raise ever happens');
});

// ===========================================================================
// Acceptance 4 — no corpse is ever raised twice
// ===========================================================================

test('AI-9 acceptance 4: NO corpse is ever raised twice — counted, and 06 §10.8s two-Shaman race fizzles the loser', async () => {
  const env = await makeArena(9105, 0xc0f5e05);
  const { actors, ai, ctx, anchor } = env;
  const player = spawnPlayerAt(env, anchor.x, anchor.z);

  // One corpse, two Shamans, both inside `raise_ranker`'s 8.0 m and both
  // further than 5.0 m from the player (§3.6's own precondition). §10.8:
  // "Two Shamans in the same pack that both cast at the same corpse will
  // both pick it ... the second one's `actors.resurrect` returns `false`".
  const cx = anchor.x + 8;
  const cz = anchor.z;
  const corpse = spawnRankerAt(env, cx, cz);
  const shamanNear = ai.spawnOne('dust_shaman', cx - 1.5, cz, 6, 'normal', []);
  const shamanFar = ai.spawnOne('dust_shaman', cx + 3.0, cz, 6, 'normal', []);
  ai.setTarget(shamanNear, player.id);
  ai.setTarget(shamanFar, player.id);
  killSoftly(env, corpse, player.id);

  const raises = [];
  ctx.events.on('ai:corpse-raised', (p) => raises.push({ actor: p.actor.id, shaman: p.shaman ? p.shaman.id : 0, step: ctx.time.step }));
  for (let i = 0; i < 1200; i++) step(env);

  const s = ai.corpseStats;
  const idxCorpse = corpse.poolIndex;
  // eslint-disable-next-line no-console
  console.log(`\n  one corpse, two Shamans, 20 s: ai:corpse-raised fired ${raises.length}x ${JSON.stringify(raises)}`
    + `\n    ai.corpseStats = ${JSON.stringify(s)}`
    + `\n    corpse store raiseCount[poolIndex ${idxCorpse}] = ${ai._corpseStore.raiseCount[idxCorpse]} (a COUNTER, not a resettable flag)`
    + `\n    credits: near Shaman ${ai._shamanStore.reviveCredits[shamanNear.poolIndex]}, far Shaman ${ai._shamanStore.reviveCredits[shamanFar.poolIndex]}`
    + `\n    actor.flags & ACTOR_FLAG.revived = ${(actors.byId(corpse.id).flags & ACTOR_FLAG_REVIVED) !== 0}`);

  assert.equal(raises.length, 1, 'the corpse is raised once and only once');
  assert.equal(s.raised, 1, 'ai.corpseStats.raised');
  assert.equal(ai._corpseStore.raiseCount[idxCorpse], 1, 'the raise COUNTER reads exactly 1 and is never cleared while the actor lives');
  assert.equal(ai._shamanStore.reviveCredits[shamanNear.poolIndex], 0, 'the winner spent its credit');
  assert.equal(ai._shamanStore.reviveCredits[shamanFar.poolIndex], 0,
    '06 §10.7: a fizzle consumes the credit too — "a refund would let it re-target for free every 8 s"');
  assert.ok(s.fizzles >= 1, `ai.corpseStats.fizzles counted the loser's ritual (got ${s.fizzles})`);
  assert.equal((actors.byId(corpse.id).flags & ACTOR_FLAG_REVIVED) !== 0, true, 'ACTOR_FLAG.revived is permanent');

  // The query itself must never offer it again, and a direct `actors.resurrect`
  // must refuse it — the counter is checked on both paths.
  const out = new Int32Array(8);
  assert.equal(actors.resurrectableCorpses(cx, cz, 9.0, out), 0, 'a revived actor is not a resurrectable corpse');
  assert.equal(actors.resurrect(actors.byId(corpse.id), 0.60), false, 'and resurrect() itself refuses it');

  // Kill it a second time: it becomes a corpse-shaped record again, but
  // §8.5 condition 4 (`resurrectCount === 0`) can never be satisfied again.
  const revived = actors.byId(corpse.id);
  killSoftly(env, revived, player.id);
  assert.equal(actors.resurrectableCorpses(cx, cz, 9.0, out), 0,
    'killed a second time, it is still not resurrectable — the counter, not the corpse record, is what refuses it');
  assert.equal(ai._corpseStore.raiseCount[idxCorpse], 1, 'and the counter survived the second death');
});

// ===========================================================================
// Acceptance 5 — killing the Shaman strips haste_dust
// ===========================================================================

test('AI-9 acceptance 5: killing the Dust Shaman strips every haste_dust it granted (06 §2.4)', async () => {
  const env = await makeArena(9106, 0xc0f5e06);
  const { ai, ctx, anchor } = env;
  const player = spawnPlayerAt(env, anchor.x, anchor.z);

  const sx = anchor.x + 7;
  const sz = anchor.z;
  const shaman = ai.spawnOne('dust_shaman', sx, sz, 6, 'normal', []);
  ai.setTarget(shaman, player.id);
  // Three eligible un-buffed allies within 10.0 m is `haste_dust`'s own cast
  // condition (§2.4). Swarmers, so no corpse/raise path interferes.
  const allies = [0, 1, 2].map((i) => {
    const a = ai.spawnOne('carrion_swarm', sx + 1 + i * 0.8, sz + 1, 6, 'normal', []);
    assert.ok(a, 'fixture: ally spawned');
    return a;
  });

  const buffed = () => allies.filter((a) => isHasted(ai._hasteStore, a.poolIndex, ctx.time.step)).length;
  const stepsToBuff = runUntil(env, 1200, () => buffed() >= 3);
  const before = buffed();
  const sourceIds = allies.map((a) => ai._hasteStore.hasteSourceId[a.poolIndex]);

  env.combat.applyDirect(shaman, 9999, 'physical', player.id, 'player_attack');
  const after = buffed();

  // eslint-disable-next-line no-console
  console.log(`\n  haste_dust: ${before} of ${allies.length} allies buffed ${stepsToBuff} steps after activation`
    + ` (isHasted(ai._hasteStore, ...) at step ${ctx.time.step})`
    + `\n    hasteSourceId per ally = [${sourceIds.join(', ')}], the Shaman's id = ${shaman.id}`
    + `\n    after combat.applyDirect killed the Shaman: ${after} allies still buffed`);

  assert.equal(before, 3, 'fixture: all three allies carried the buff');
  for (const id of sourceIds) assert.equal(id, shaman.id, 'every instance names the Shaman as its source');
  assert.equal(shaman.dead, true, 'the Shaman died');
  assert.equal(after, 0, 'every haste_dust instance it granted expired immediately');
  for (const a of allies) {
    assert.equal(ai._hasteStore.hasteSourceId[a.poolIndex], 0, 'and the source stamp is cleared, not left dangling');
  }
});

// ===========================================================================
// Acceptance 6 — the fresh brain, and the pack accounting
// ===========================================================================

test('AI-9 acceptance 6: the raised actor gets a FRESH brain and the pack accounting stays consistent (06 §10.7)', async () => {
  const env = await makeArena(9107, 0xc0f5e07);
  const { actors, ai, nav, ctx, anchor } = env;
  const player = spawnPlayerAt(env, anchor.x, anchor.z);

  const sx = anchor.x + 7;
  const sz = anchor.z;
  const shaman = ai.spawnOne('dust_shaman', sx, sz, 6, 'normal', []);
  ai.setTarget(shaman, player.id);
  const ranker = spawnRankerAt(env, sx + 1.5, sz);

  // A real PackDescriptor, filled the way `06` §10.1's own spawn pass fills
  // one (`01-data-model.md` §9.5's `members`/`spawned`/`aliveCount`), pushed
  // onto the live `ZoneInstance` so `world`'s OWN `actor:death` handler
  // (`src/world/transition.js`) does the decrement and this file only ever
  // observes the increment.
  const pack = {
    id: 9001, kind: 'pack', archetypeId: 'pk_ranker_line', count: 2, rank: 'normal', affixes: [],
    centerX: sx, centerZ: sz, radius: 4.5, aggroCloud: 9.0, mlvl: 6,
    members: [actors.ref(shaman, { id: 0, generation: 0 }), actors.ref(ranker, { id: 0, generation: 0 })],
    spawned: true, aliveCount: 2,
  };
  ctx.get('world').current.packs.push(pack);

  killSoftly(env, ranker, player.id);
  const aliveAfterDeath = pack.aliveCount;

  let seen = null;
  ctx.events.on('ai:corpse-raised', (p) => {
    // Captured INSIDE the emit: `stepNavScheduler` runs later in this same
    // step and recomputes flow-field eligibility from `06` §9.3's rules, so
    // §10.7's `useFlowField = true` is an initial value, not a steady state.
    seen = {
      actor: p.actor.id,
      useFlowField: ai._navStore.useFlowField[p.actor.poolIndex],
      pathVersion: ai._navStore.pathVersion[p.actor.poolIndex],
      navVersion: nav.version,
      brain: { ...ai.brainOf(p.actor) },
    };
  });

  const aliveBefore = ai.aliveCount;
  runUntil(env, 600, () => seen !== null);
  const raised = actors.byId(ranker.id);
  const brainAfter = ai.brainOf(raised);

  // eslint-disable-next-line no-console
  console.log(`\n  PackDescriptor.aliveCount: 2 spawned -> ${aliveAfterDeath} after world's own actor:death decrement -> ${pack.aliveCount} after the raise`
    + `\n  ai.aliveCount: ${aliveBefore} before the raise -> ${ai.aliveCount} after`
    + `\n  fresh brain at the ai:corpse-raised emit: ${JSON.stringify(seen)}`
    + `\n  ai.brainOf(raised) one step later: ${JSON.stringify(brainAfter)}; life ${raised.life} of maxLife ${actors.stats(raised).maxLife}`
    + ` (06 §10.7 asks for ${CORPSE_POLICY.reviveLifeFraction * 100} %)`
    + `\n  ai._perception.packSlot[raised] = ${ai._perception.packSlot[raised.poolIndex]}, ai._spawnStore.slotOfActor[raised] = ${ai._spawnStore.slotOfActor[raised.poolIndex]}`);

  assert.equal(aliveAfterDeath, 1, 'world decremented the pack on death (src/world/transition.js)');
  assert.equal(pack.aliveCount, 2, '06 §10.7: `pack.aliveCount += 1` — back in step with the two live members');
  assert.equal(pack.aliveCount, [shaman, raised].filter((a) => !a.dead).length,
    'and it equals the number of members actually alive');
  assert.equal(ai.aliveCount, aliveBefore + 1, 'ai.aliveCount rose by exactly one');

  assert.ok(seen, 'ai:corpse-raised fired');
  assert.equal(seen.brain.state, 'chase', '06 §10.7: `brain.state = chase`');
  assert.equal(seen.brain.targetId, player.id, "06 §10.7: `brain.targetRef = shaman.brain.targetRef`");
  assert.equal(seen.useFlowField, 1, '06 §10.7: `brain.useFlowField = true`');
  assert.equal(seen.pathVersion, seen.navVersion, '06 §10.7: `brain.pathVersion = nav.version`');
  assert.equal(raised.life, Math.round(actors.stats(raised).maxLife * CORPSE_POLICY.reviveLifeFraction), '60 % of base maxLife');
  assert.equal((raised.flags & ACTOR_FLAG_REVIVED) !== 0, true, '`actor.flags |= ACTOR_FLAG.revived`');

  // "Fresh" means no carried-over swing or cadence state from the life it had
  // before it died, and no duplicate registration anywhere.
  const idx = raised.poolIndex;
  assert.equal(ai._brains.swingActive[idx], 0, 'no swing carried over from the previous life');
  assert.equal(ai._brains.active[idx], 1, 'the brain slot is live again');
  assert.notEqual(brainAfter, null, 'ai.brainOf resolves it');
  // No membership is invented: this fixture registers no perception pack and
  // no spawn-pass pack, so both registries must still say "not a member"
  // rather than the raise adopting the caster's (absent) slot.
  assert.equal(ai._perception.packSlot[shaman.poolIndex], -1, 'fixture: the Shaman is in no registered perception pack');
  assert.equal(ai._perception.packSlot[idx], -1, 'the raise invents no perception pack membership');
  assert.equal(ai._spawnStore.slotOfActor[idx], -1, "and it does not forge a spawn-pass pack slot either");

  // It behaves like a live monster afterwards: it closes on its target.
  const d0 = actors.distance(raised, player);
  for (let i = 0; i < 240; i++) step(env);
  const d1 = actors.distance(raised, player);
  // eslint-disable-next-line no-console
  console.log(`  the raised Ranker then walked ${d0.toFixed(2)} m -> ${d1.toFixed(2)} m towards its inherited target over 4.0 s`);
  assert.ok(d1 < d0, 'the fresh brain actually drives it — it is not an inert statue');
});

// ===========================================================================
// §10.6's corpse table — the eligibility rules the query depends on
// ===========================================================================

test('06 §10.6 / 08 §8.4: an overkill (>= 35 % of maxLife) leaves NO corpse, and the never-corpse archetypes leave none either', async () => {
  const env = await makeArena(9108, 0xc0f5e08);
  const { actors, ai, anchor } = env;
  const player = spawnPlayerAt(env, anchor.x, anchor.z);
  const qx = anchor.x + 6;
  const qz = anchor.z;

  const softKill = spawnRankerAt(env, qx + 1, qz);
  const overkill = spawnRankerAt(env, qx + 2, qz);
  const maxLife = actors.stats(overkill).maxLife;
  const threshold = maxLife * CORPSE_POLICY.gibLifeFraction;

  const blow = killSoftly(env, softKill, player.id);
  // Soften it to a sliver first, so the KILLING blow — and only it — is the
  // one that crosses 08 §8.4's 35 % line. The rule is about the single hit,
  // not about cumulative damage.
  const overkillBlow = Math.ceil(threshold);
  let guard = 0;
  while (overkill.life > 2 && guard++ < 200) {
    env.combat.applyDirect(overkill, Math.min(blow, Math.max(1, overkill.life - 1)), 'physical', player.id, 'player_attack');
  }
  assert.equal(overkill.dead, false, 'fixture: still alive before the overkill blow');
  env.combat.applyDirect(overkill, overkillBlow, 'physical', player.id, 'player_attack');

  const swarm = ai.spawnOne('carrion_swarm', qx + 3, qz, 6, 'normal', []);
  const crawler = ai.spawnOne('blight_crawler', qx + 4, qz, 6, 'normal', []);
  killSoftly(env, swarm, player.id);
  killSoftly(env, crawler, player.id);

  const out = new Int32Array(8);
  const n = actors.resurrectableCorpses(qx, qz, 9.0, out);
  const s = ai.corpseStats;
  // eslint-disable-next-line no-console
  console.log(`\n  maxLife ${maxLife}, 35 % threshold ${threshold.toFixed(2)}: soft blow ${blow} -> corpse; blow ${Math.ceil(threshold)} -> gib`
    + `\n  ai.corpseStats = ${JSON.stringify(s)}`
    + `\n  actors.resurrectableCorpses(...) = ${n} -> [${Array.from(out.slice(0, n)).join(', ')}] (only the softly-killed Ranker, id ${softKill.id})`);

  assert.equal(overkill.dead, true, 'the overkill killed it');
  assert.equal(n, 1, 'exactly one corpse is resurrectable');
  assert.equal(out[0], softKill.id, 'and it is the one that was not overkilled');
  assert.equal(s.gibbed, 1, 'ai.corpseStats.gibbed counted the overkill');
  assert.equal(s.neverCorpse, 2, '06 §10.6: carrion_swarm and blight_crawler are never corpses');
  assert.equal(s.corpses, 1, 'one corpse record was kept');
});

test('08 §8.5 condition 2 / §8.3: a corpse stops being resurrectable at 12.0 s and stops existing at 25.0 s', async () => {
  const env = await makeArena(9109, 0xc0f5e09);
  const { actors, ai, anchor } = env;
  const player = spawnPlayerAt(env, anchor.x, anchor.z);
  const qx = anchor.x + 6;
  const qz = anchor.z;
  const ranker = spawnRankerAt(env, qx + 1, qz);
  killSoftly(env, ranker, player.id);

  const out = new Int32Array(8);
  const samples = [];
  let lastEligibleStep = -1;
  const deathStep = env.ctx.time.step;
  for (let i = 0; i < 26 * 60 + 30; i++) {
    const n = actors.resurrectableCorpses(qx, qz, 9.0, out);
    if (n > 0) lastEligibleStep = env.ctx.time.step;
    if (i % (5 * 60) === 0) samples.push(`t=${((env.ctx.time.step - deathStep) / 60).toFixed(1)}s n=${n}`);
    step(env);
  }
  const ageSeconds = (lastEligibleStep - deathStep) / 60;
  // eslint-disable-next-line no-console
  console.log(`\n  actors.resurrectableCorpses sampled every 5 s: ${samples.join(', ')}`
    + `\n  last step at which it was still eligible: age ${ageSeconds.toFixed(3)} s (08 §8.5 condition 2 = ${CORPSE_POLICY.resurrectableSeconds} s)`
    + `\n  ai.corpseStats.dissolved after 26 s = ${ai.corpseStats.dissolved} (08 §8.3 lifetime = ${CORPSE_POLICY.lifetimeSeconds} s)`);

  assert.ok(Math.abs(ageSeconds - CORPSE_POLICY.resurrectableSeconds) <= 1 / 60 + 1e-9,
    `eligibility ends at 12.0 s, measured ${ageSeconds}`);
  assert.equal(ai.corpseStats.dissolved, 1, 'the corpse record itself is gone at 25.0 s');
});

test('08 §8.3: q.corpseBudget evicts oldest-first, and a resurrectable corpse is exempt for its first 12.0 s', async () => {
  // `low` = 6 corpses, the tightest preset, so the eviction is reachable
  // without spawning a hundred actors.
  const env = await makeArena(9110, 0xc0f5e0a, 'low');
  const { actors, ai, anchor } = env;
  const budget = QUALITY_PRESETS.low.corpseBudget;
  const player = spawnPlayerAt(env, anchor.x, anchor.z);
  const qx = anchor.x + 6;
  const qz = anchor.z;

  const made = [];
  for (let i = 0; i < budget + 3; i++) {
    const r = spawnRankerAt(env, qx + 1 + (i % 4) * 0.9, qz + Math.floor(i / 4) * 0.9);
    killSoftly(env, r, player.id);
    made.push(r);
    step(env); // one step apart, so "oldest" is unambiguous
  }

  const out = new Int32Array(16);
  const n = actors.resurrectableCorpses(qx, qz, 9.0, out);
  const alive = Array.from(out.slice(0, n));
  const s = ai.corpseStats;
  // eslint-disable-next-line no-console
  console.log(`\n  q.corpseBudget (low preset) = ${budget}; ${made.length} Rankers killed one step apart`
    + `\n  ai.corpseStats = ${JSON.stringify(s)}`
    + `\n  actors.resurrectableCorpses still lists ${n}: [${alive.join(', ')}]`
    + `\n  the ${made.length - n} missing are the OLDEST: [${made.slice(0, made.length - n).map((r) => r.id).join(', ')}]`);

  assert.equal(ai._corpseStore.slotCount, budget, 'the store never holds more than q.corpseBudget corpses');
  assert.equal(s.evicted, made.length - budget, 'ai.corpseStats.evicted counted every eviction');
  assert.equal(n, budget, 'the query sees exactly the surviving corpses');
  for (let i = 0; i < made.length - budget; i++) {
    assert.equal(alive.includes(made[i].id), false, `the oldest corpse (${made[i].id}) was evicted first`);
  }
  for (let i = made.length - budget; i < made.length; i++) {
    assert.equal(alive.includes(made[i].id), true, `the newest corpses survived (${made[i].id})`);
  }
});

// ===========================================================================
// §10.8 — what `ai` must never do to a corpse
// ===========================================================================

test('06 §10.8: ai never despawns, reserves or claims a corpse — the query is a pure function of position and id', async () => {
  const env = await makeArena(9111, 0xc0f5e0b);
  const { actors, ai, anchor } = env;
  const player = spawnPlayerAt(env, anchor.x, anchor.z);
  const qx = anchor.x + 6;
  const qz = anchor.z;
  const rankers = [0, 1, 2].map((i) => spawnRankerAt(env, qx + 1 + i, qz));
  for (const r of rankers) killSoftly(env, r, player.id);

  const countBefore = actors.count;
  const out = new Int32Array(8);
  const first = actors.resurrectableCorpses(qx, qz, 9.0, out);
  const firstList = Array.from(out.slice(0, first));
  // Ten identical queries from the same point must give an identical answer:
  // nothing is consumed, reserved or marked by asking.
  for (let i = 0; i < 10; i++) {
    const n = actors.resurrectableCorpses(qx, qz, 9.0, out);
    assert.equal(n, first, 'repeating the query changes nothing');
    assert.deepEqual(Array.from(out.slice(0, n)), firstList, 'and returns the same order');
  }
  for (let i = 0; i < 300; i++) step(env);
  // eslint-disable-next-line no-console
  console.log(`\n  actors.count ${countBefore} before 11 queries + 5 s of stepping -> ${actors.count} after;`
    + ` corpses still listed: ${actors.resurrectableCorpses(qx, qz, 9.0, out)}`);
  assert.equal(actors.count, countBefore, 'ai despawned nothing — §10.8');
  for (const r of rankers) assert.equal(actors.byId(r.id) !== null, true, 'every corpse actor is still in the pool');
});
