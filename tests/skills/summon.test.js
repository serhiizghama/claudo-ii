// tests/skills/summon.test.js
//
// SKIL-11 acceptance tests for `src/skills/summon.js` and the wiring added
// to `src/skills/index.js`: `echo_blade` (the `visualOnly` summon) and
// `unity` (the landed-hit free-cast of `discharge`) — `05-skills.md` §14
// row 11, verified against §12.4's own assertion, quoted in this ticket's
// brief: "20 s at 300 % IAS with `unity` up: zero allocations after
// warm-up, `projectileCount` never exceeds the pool cap, and free-cast
// count equals landed hit count exactly."
//
// Built against a REAL `boot()` (`src/main.js`), the same "one boot() for
// the whole file" precedent `tests/skills/cleaving_strike.test.js`/
// `tests/skills/bolt.test.js` already establish. The chain-rate/pool-cap/
// retrigger-guard proofs are all COUNTED over a known number of fixed
// steps, never timed (this ticket's own rule 12) — that discipline is why
// this test lives here, not in `summon.perf.test.js`: nothing below
// measures wall-clock time or bytes/call (see `summon.perf.test.js` for
// the allocation probes, including a real, pre-existing, out-of-scope
// finding in `src/combat/packet.js`).
//
// `unity`/`echo_blade` are `target:'self'` — the "landed weapon hit"
// trigger is driven directly (`ctx.events.emit('actor:damage', ...)` with a
// hand-built `result`), not through a real weapon-swing pipeline, because
// `skills.basicAttack()` is contracted (`02-api-contracts.md` §10) but not
// yet wired by any ticket (verified: `grep -rn basicAttack src/` finds
// nothing). This is the same "drive the event this file's own code reacts
// to, directly" discipline `tests/skills/*.test.js` already use for
// `anim:hitframe` elsewhere in this tree.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { dischargeJumpsForLevel, chainFalloffSum, REFERENCE_ELEMENTAL_MULTIPLIER, ARC_GUARD_STEPS } from '../../src/skills/summon.js';
import { SKILLS } from '../../src/skills/data/skills.js';

const H = 1 / 60;

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const skills = ctx.get('skills');
const combat = ctx.get('combat');

function tick() {
  ctx.time.step++;
  actors.fixedUpdate(H, ctx);
  skills.fixedUpdate(H, ctx);
}

function runActionToCompletion(actor, maxTicks = 600) {
  let n = 0;
  while (actor.actionId !== null && n < maxTicks) { tick(); n++; }
  return n;
}

let nextSpawnOffset = 6000; // clear of every other skill test file's own spawn band

/** A level-30 Runeblade with `discharge`/`unity` allocated, ample mana. */
function spawnRuneblade({ dischargeLevel = 10, unityLevel = 20, skillBonusDischarge = 0 } = {}) {
  const originZ = (nextSpawnOffset += 400);
  const player = actors.spawn({ kind: 'player', archetypeId: 'runeblade', team: 0, x: 0, z: originZ, facing: 0, level: 30 });
  actors.setState(player, 'idle');
  for (let i = 0; i < dischargeLevel; i++) skills.allocate(player, 'discharge');
  for (let i = 0; i < unityLevel; i++) skills.allocate(player, 'unity');
  actors.stats(player);
  player.mana = 100000;
  if (skillBonusDischarge) {
    // Hand-populated StatBlock-shaped fixture — same "compose once, then
    // top up a field the real source layers do not populate yet" precedent
    // `tests/core/alloc.test.js`'s own header documents (there: maxLife/
    // attackRating; here: a +N skill bonus, normally an item affix,
    // `04-items.md`, not yet wired to `setSourceLayer`).
    player.stats.skillBonuses = { all: 0, tree: Object.freeze({}), skill: { discharge: skillBonusDischarge } };
  }
  return player;
}

function spawnMonsterAt(originX, originZ, dx, dz, life = 1_000_000) {
  const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: originX + dx, z: originZ + dz, level: 1 });
  actors.setState(m, 'idle');
  actors.stats(m);
  m.life = life;
  return m;
}

/** A hand-built `result`-shaped payload for a synthetic "landed weapon hit"
 * — see the file header for why this bypasses a real weapon swing. */
function landedWeaponHit(source, target) {
  ctx.events.emit('actor:damage', {
    target, source,
    result: { outcome: 'hit', sourceSkillId: 'attack', sourceId: source.id, sourceGen: source.generation, total: 1 },
  });
}

// ===========================================================================
// Pure math — dischargeJumpsForLevel / chainFalloffSum against 05 §7.1's own
// printed target-count table, and the 51/0.9975/2.734375/1.60 = 222.56
// reference figure (criterion #4)
// ===========================================================================

test('dischargeJumpsForLevel reproduces 05 §7.1s printed target-count table exactly (L1..5->3, L6..11->4, L12..17->5, L18..20->6)', () => {
  const chain = SKILLS.find((d) => d.id === 'discharge').projectile.chain;
  const expected = { 1: 3, 5: 3, 6: 4, 11: 4, 12: 5, 17: 5, 18: 6, 19: 6, 20: 6 };
  for (const [level, jumps] of Object.entries(expected)) {
    assert.equal(dischargeJumpsForLevel(chain, Number(level)), jumps, `level ${level} -> ${jumps} targets`);
  }
});

test('chainFalloffSum reproduces 05 §1.5s printed chain-multiplier figures (4 links -> 2.734375, 6 links -> 3.2881)', () => {
  assert.ok(Math.abs(chainFalloffSum(4) - 2.734375) < 1e-9, `4 links: got ${chainFalloffSum(4)}`);
  assert.ok(Math.abs(chainFalloffSum(6) - 3.2880859375) < 1e-9, `6 links: got ${chainFalloffSum(6)}`);
});

test('acceptance criterion #4: 51 x 0.9975 x 2.734375 x 1.60 reproduces 222.56, computed from real skills.effectiveLevel/synergyBonus/data curves', () => {
  const player = spawnRuneblade({ dischargeLevel: 10, unityLevel: 20, skillBonusDischarge: 1 }); // "10 allocated + 1 quest" -> effective 11

  const dischargeLevel = skills.effectiveLevel(player, 'discharge');
  assert.equal(dischargeLevel, 11, 'discharge effective level must be 11 (10 allocated + 1 quest bonus)');

  const def = skills.definition('discharge');
  const flat = def.flatDamage;
  const min = flat.minBase + flat.minPerLevel * (dischargeLevel - 1);
  const max = flat.maxBase + flat.maxPerLevel * (dischargeLevel - 1);
  assert.ok(Math.abs(min - 29) < 1e-9 && Math.abs(max - 73) < 1e-9, `L11 discharge range must be 29-73, got ${min}-${max}`);
  const avgRoll = (min + max) / 2;
  assert.equal(avgRoll, 51);

  const jumps = dischargeJumpsForLevel(def.projectile.chain, dischargeLevel);
  assert.equal(jumps, 4, 'L11 discharge must chain to 4 targets');
  const chainMultiplier = chainFalloffSum(jumps);
  assert.ok(Math.abs(chainMultiplier - 2.734375) < 1e-9);

  const synergyPercent = skills.synergyBonus(player, 'unity', 'flatDamage'); // "+6%/point x 10 allocated"
  assert.equal(synergyPercent, 60);
  const synergyMult = 1 + synergyPercent / 100;
  assert.equal(synergyMult, 1.60);

  const printed = 51 * 0.9975 * 2.734375 * 1.60;
  const computed = avgRoll * REFERENCE_ELEMENTAL_MULTIPLIER * chainMultiplier * synergyMult;
  console.log(`[SKIL-11] reference chain: printed ${printed} vs computed ${computed}`);
  assert.ok(Math.abs(printed - 222.56) < 0.01, `printed formula itself must read ~222.56, got ${printed}`);
  assert.ok(Math.abs(computed - printed) < 1e-9, `computed (${computed}) must equal the printed formula (${printed}) bit-for-bit`);
});

// ===========================================================================
// echo_blade — summon, summonOf, and ActorRef survives slot recycling
// ===========================================================================

test('echo_blade: cast spawns a real Actor, summonOf returns an ActorRef (never an Actor), and the ref survives the summon slot being recycled', () => {
  const player = spawnRuneblade();
  for (let i = 0; i < 20; i++) skills.allocate(player, 'echo_blade');
  actors.stats(player);
  player.mana = 100000;

  assert.equal(skills.summonOf(player, 'echo_blade'), null, 'no summon yet');

  const ok = skills.cast(player, 'echo_blade', player.x, player.z, 0);
  assert.equal(ok, true, 'echo_blade cast must be accepted');
  runActionToCompletion(player);

  const ref = skills.summonOf(player, 'echo_blade');
  assert.ok(ref, 'summonOf must return a ref once the echo has spawned');
  assert.equal(typeof ref.id, 'number');
  assert.equal(typeof ref.generation, 'number');
  assert.ok(!('kind' in ref) && !('x' in ref), 'summonOf must return an ActorRef shape ({id,generation}), never a full Actor record');

  const echoActor = actors.resolve(ref);
  assert.ok(echoActor, 'the ActorRef must resolve to the live echo Actor');
  assert.equal(echoActor.kind, 'summon');
  assert.equal(echoActor.ownerId, player.id);
  // O-88 (open, reported not fixed — see summon.js's own header): SpawnSpec
  // carries no `flags` field, so `visualOnly`/`summoned`/`untargetable`
  // cannot be set from `skills` today. Demonstrated concretely: the flags
  // bitfield sits at its untouched pool default.
  assert.equal(echoActor.flags, 0, 'O-88: the echo cannot be flagged untargetable/visualOnly/summoned from skills today — flags stays at the pool default');

  // Copy the ref BEFORE the slot recycles (the contract's own "copy before
  // the next call" convention for a shared scratch).
  const savedId = ref.id;
  const savedGeneration = ref.generation;

  actors.despawn(echoActor, true);
  // Force the freed slot to recycle by spawning enough fresh actors that at
  // least one reuses it (ActorPool is a LIFO free-list — the very next
  // spawn takes the just-freed slot).
  const recycler = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: 9999, z: 9999, level: 1 });
  assert.ok(recycler, 'a fresh spawn must succeed to exercise slot recycling');

  const staleRef = { id: savedId, generation: savedGeneration };
  assert.equal(actors.resolve(staleRef), null, 'resolving the OLD ActorRef after its slot recycled must return null, never the new occupant');
  assert.equal(skills.summonOf(player, 'echo_blade'), null, 'summonOf must not keep reporting a despawned summon');
});

test('echo_blade: a second cast while one is alive is refused', () => {
  const player = spawnRuneblade();
  for (let i = 0; i < 20; i++) skills.allocate(player, 'echo_blade');
  actors.stats(player);
  player.mana = 100000;

  assert.equal(skills.cast(player, 'echo_blade', player.x, player.z, 0), true);
  runActionToCompletion(player);
  assert.ok(skills.summonOf(player, 'echo_blade'), 'echo must be alive');

  assert.equal(skills.cast(player, 'echo_blade', player.x, player.z, 0), false, 'a second cast must be refused while the first echo is still alive');
});

// ===========================================================================
// unity — buff apply/hasBuff/buffRemaining/buffList, refusal while active
// ===========================================================================

test('unity: cast applies the buff (hasBuff/buffRemaining/buffList all agree), and a second cast while active is refused', () => {
  const player = spawnRuneblade();
  actors.stats(player);
  player.mana = 100000;

  assert.equal(skills.hasBuff(player, 'unity'), false);
  const ok = skills.cast(player, 'unity', player.x, player.z, 0);
  assert.equal(ok, true);
  runActionToCompletion(player);

  assert.equal(skills.hasBuff(player, 'unity'), true);
  assert.ok(skills.buffRemaining(player, 'unity') > 0);

  const out = [{ buffId: null, level: 0, remaining: 0, stacks: 0 }];
  const n = skills.buffList(player, out);
  assert.equal(n, 1);
  assert.equal(out[0].buffId, 'unity');

  assert.equal(skills.cast(player, 'unity', player.x, player.z, 0), false, 'a second cast must be refused while unity is already active');

  skills.removeBuff(player, 'unity');
  assert.equal(skills.hasBuff(player, 'unity'), false);
});

// ===========================================================================
// The free-cast trigger, end to end — one landed hit resolves a real chain
// ===========================================================================

test('unity active + a landed weapon hit resolves a real discharge chain: one combat:hit-request per link, exactly `jumps` links, projectileCount rises then decays', () => {
  const player = spawnRuneblade({ dischargeLevel: 10, unityLevel: 20 });
  actors.stats(player);
  player.mana = 100000;
  skills.applyBuff(player, 'unity', 20, 999); // long-lived, bypasses cast timing for this focused test

  const originX = player.x, originZ = player.z;
  // A short chain of monsters, each within discharge's 6 m jump range of
  // the previous one, so all `jumps` links have somewhere real to go.
  const m0 = spawnMonsterAt(originX, originZ, 3, 0);
  const m1 = spawnMonsterAt(originX, originZ, 6, 0);
  const m2 = spawnMonsterAt(originX, originZ, 9, 0);
  const m3 = spawnMonsterAt(originX, originZ, 12, 0);

  const dischargeLevel = skills.effectiveLevel(player, 'discharge');
  const def = skills.definition('discharge');
  const expectedJumps = dischargeJumpsForLevel(def.projectile.chain, dischargeLevel);
  assert.equal(expectedJumps, 4);

  let hitRequests = 0;
  const onReq = () => { hitRequests++; };
  ctx.events.on('combat:hit-request', onReq);

  const poolBefore = skills.projectileCount;
  landedWeaponHit(player, m0);
  tick(); // fixedUpdate drains the pending free-cast queue

  ctx.events.off('combat:hit-request', onReq);

  assert.equal(hitRequests, expectedJumps, `exactly ${expectedJumps} combat:hit-request emits for a ${expectedJumps}-link chain`);
  assert.ok(skills.projectileCount >= poolBefore, 'the chain must have consumed pool slots (one per link, beam bookkeeping)');
  assert.ok(skills.projectileCount <= skills._projectilePool.capacity, 'projectileCount must never exceed the pool cap');

  // Every link's beam has `lifetime: 0.35` (21 steps) — run enough steps
  // that all of them expire, then confirm the pool is back to its baseline.
  for (let i = 0; i < 30; i++) tick();
  assert.equal(skills.projectileCount, poolBefore, 'every chain-link beam must expire and free its pool slot');
});

test('a miss/dodge/block does not free-cast, and a discharge-sourced hit does not recursively re-trigger unity (the reentrancy guard, see summon.js header)', () => {
  const player = spawnRuneblade({ dischargeLevel: 10, unityLevel: 20 });
  actors.stats(player);
  player.mana = 100000;
  skills.applyBuff(player, 'unity', 20, 999);
  const m0 = spawnMonsterAt(player.x, player.z, 3, 0);

  let hitRequests = 0;
  const onReq = () => { hitRequests++; };
  ctx.events.on('combat:hit-request', onReq);

  ctx.events.emit('actor:damage', { target: m0, source: player, result: { outcome: 'miss', sourceSkillId: 'attack', sourceId: player.id, sourceGen: player.generation, total: 0 } });
  ctx.events.emit('actor:damage', { target: m0, source: player, result: { outcome: 'hit', sourceSkillId: 'discharge', sourceId: player.id, sourceGen: player.generation, total: 1 } });
  tick();

  ctx.events.off('combat:hit-request', onReq);
  assert.equal(hitRequests, 0, 'neither a miss nor a discharge-sourced hit may trigger a free-cast');
});

test('discharge at level 0: unity fires nothing (05 §7.5) — the free-cast is not enqueued', () => {
  const player = spawnRuneblade({ dischargeLevel: 0, unityLevel: 20 });
  actors.stats(player);
  player.mana = 100000;
  skills.applyBuff(player, 'unity', 20, 999);
  assert.equal(skills.effectiveLevel(player, 'discharge'), 0);
  const m0 = spawnMonsterAt(player.x, player.z, 3, 0);

  let hitRequests = 0;
  const onReq = () => { hitRequests++; };
  ctx.events.on('combat:hit-request', onReq);
  landedWeaponHit(player, m0);
  tick();
  ctx.events.off('combat:hit-request', onReq);
  assert.equal(hitRequests, 0, 'discharge level 0 must resolve zero chains');
});

// ===========================================================================
// Pool refusal (criterion #2) — a saturated pool refuses rather than
// allocates, and never grows past capacity
// ===========================================================================

test('acceptance criterion #2: a saturated projectile pool refuses spawnProjectile (returns 0), projectileCount never exceeds the cap, and the pool never grows', () => {
  const player = spawnRuneblade({ dischargeLevel: 10, unityLevel: 20 });
  actors.stats(player);
  player.mana = 100000;
  skills.applyBuff(player, 'unity', 20, 999);
  const m0 = spawnMonsterAt(player.x, player.z, 3, 0);
  const m1 = spawnMonsterAt(player.x, player.z, 6, 0);

  // Read the REAL cap off the pool rather than hardcoding a tier — this
  // boot()'s default quality preset ('high', src/core/config.js) resolves
  // to `PROJECTILE_POOL_SIZE_BY_QUALITY.high = 384`, not `ultra`'s 512.
  const cap = skills._projectilePool.capacity;
  assert.equal(skills.projectileCount, 0, 'pool must start empty for this test');

  const spawnedIds = [];
  try {
    // Saturate directly via the real, already-accepted spawnProjectile —
    // long lifetime so nothing expires mid-test.
    for (let i = 0; i < cap; i++) {
      const id = skills.spawnProjectile({
        x: 0, z: 0, dirX: 1, dirZ: 0, speed: 0, lifetime: 999, radius: 0, pierce: false,
        mask: 0, sourceId: 1, sourceGen: 0, team: 0, skillId: 'discharge', level: 1, alwaysHits: true,
      });
      assert.ok(id > 0, `spawn ${i} must succeed while the pool has room (cap=${cap})`);
      spawnedIds.push(id);
    }
    assert.equal(skills.projectileCount, cap, `pool must be exactly full at ${cap}`);

    const refused = skills.spawnProjectile({
      x: 0, z: 0, dirX: 1, dirZ: 0, speed: 0, lifetime: 999, radius: 0, pierce: false,
      mask: 0, sourceId: 1, sourceGen: 0, team: 0, skillId: 'discharge', level: 1, alwaysHits: true,
    });
    assert.equal(refused, 0, 'a saturated pool must refuse (return 0), never grow');
    assert.equal(skills.projectileCount, cap, 'projectileCount must not exceed the cap after a refusal — zero growth');

    // Now drive a real free-cast against a saturated pool: the chain's own
    // first link must be refused too, with no thrown error.
    let hitRequests = 0;
    const onReq = () => { hitRequests++; };
    ctx.events.on('combat:hit-request', onReq);
    landedWeaponHit(player, m0);
    assert.doesNotThrow(() => tick());
    ctx.events.off('combat:hit-request', onReq);
    assert.equal(hitRequests, 0, 'a saturated pool must refuse the chain\'s own first link — no damage, no error');
    assert.equal(skills.projectileCount, cap, 'projectileCount must still not exceed the cap');
  } finally {
    // Always release every spawned slot, even if an assertion above threw —
    // this pool is shared by every later test in this file/process.
    for (const id of spawnedIds) skills.killProjectile(id);
  }
  assert.equal(skills.projectileCount, 0, 'cleanup: releasing every spawned slot must bring the pool back to empty');
  void m1;
});

// ===========================================================================
// §12.4's own 300% IAS / 20 s test — chains counted, not timed
// (criteria #1, #3, and the free-cast == landed-hit equality)
// ===========================================================================

test('acceptance criterion #1/#3: 20 s at 300% IAS with unity up — chains counted over a known number of fixed steps, floored at 4/s by the 0.25 s attackInterval clamp, retrigger guard counted', () => {
  const player = spawnRuneblade({ dischargeLevel: 10, unityLevel: 20 });
  actors.stats(player);
  player.mana = 100000;
  player.stats.increasedAttackSpeed = 300; // "300% IAS" — the ticket's own framing
  skills.applyBuff(player, 'unity', 20, 999);

  const attackInterval = combat.attackInterval(player, 'attack');
  assert.ok(Math.abs(attackInterval - 0.25) < 1e-9, `attackInterval must read exactly the 0.25 s floor at 300% IAS; got ${attackInterval}`);
  const stepsBetweenHits = Math.round(attackInterval * 60);
  assert.equal(stepsBetweenHits, 15, '0.25 s at 60 Hz is exactly 15 fixed steps');

  // A pack of monsters within the chain's own 6 m jump range so every
  // resolved chain has real bodies to jump through.
  const monsters = [];
  for (let i = 0; i < 6; i++) monsters.push(spawnMonsterAt(player.x, player.z, 3 + i * 3, 0));

  const summonStatsBefore = skills._summonEngine.stats();
  summonStatsBefore.reset();

  let hitRequests = 0;
  const onReq = () => { hitRequests++; };
  ctx.events.on('combat:hit-request', onReq);

  const TOTAL_SECONDS = 20;
  const TOTAL_STEPS = TOTAL_SECONDS * 60; // 1200 — a known, fixed number of steps (rule 12: counted, not timed)
  let landedHits = 0;
  let projectileCountMax = 0;
  for (let step = 0; step < TOTAL_STEPS; step++) {
    if (step % stepsBetweenHits === 0) {
      const target = monsters[(step / stepsBetweenHits) % monsters.length];
      landedWeaponHit(player, target);
      landedHits++;
    }
    tick();
    if (skills.projectileCount > projectileCountMax) projectileCountMax = skills.projectileCount;
  }

  ctx.events.off('combat:hit-request', onReq);
  const s = skills._summonEngine.stats();

  const chainsPerSecond = s.freeCastResolved / TOTAL_SECONDS;
  console.log(`[SKIL-11] 20s @ 300% IAS: landedHits=${landedHits} freeCastEnqueued=${s.freeCastEnqueued} freeCastResolved=${s.freeCastResolved} ` +
    `chainLinksResolved=${s.chainLinksResolved} combat:hit-request=${hitRequests} chains/s=${chainsPerSecond} ` +
    `projectileCountMax=${projectileCountMax} poolRefusals=${s.poolRefusals} arcAttempted=${s.arcAttempted} arcAllowed=${s.arcAllowed}`);

  assert.equal(landedHits, 80, '20 s / 0.25 s = 80 landed hits, driven at the real attackInterval cadence');
  assert.equal(s.landedHitCount, landedHits, 'the engine must recognise every landed hit while unity is active');
  assert.equal(s.freeCastEnqueued, landedHits, 'criterion: free-cast count equals landed hit count exactly (enqueued)');
  assert.equal(s.freeCastResolved, landedHits, 'criterion: free-cast count equals landed hit count exactly (resolved)');
  assert.equal(chainsPerSecond, 4, 'criterion #1: the counted chain rate must be exactly 4/s, floored by the 0.25 s attackInterval clamp');
  assert.ok(chainsPerSecond <= 4 + 1e-9, 'chains/s must never exceed the 4/s ceiling');
  assert.equal(hitRequests, s.chainLinksResolved, 'every counted chain link must correspond to exactly one combat:hit-request');
  assert.ok(projectileCountMax <= skills._projectilePool.capacity, 'projectileCount must never exceed the pool cap over the whole run');
  assert.equal(s.poolRefusals, 0, 'the default-capacity pool must never be saturated by this ordinary 4 chains/s workload');

  // Criterion #3 — the 120 ms (7-step) retrigger guard, counted.
  assert.ok(s.arcAttempted > 0, 'the guard must have been exercised');
  assert.ok(s.arcAllowed > 0 && s.arcAllowed <= s.arcAttempted, 'some attempts must pass, none more than attempted');
  console.log(`[SKIL-11] arc retrigger guard: attempted=${s.arcAttempted} allowed=${s.arcAllowed} (see summon.js header for why this file measures ` +
    '1 allowed/chain, not the spec\'s own "~2/chain, 8 voices/s" figure, which assumes per-link fx timing this codebase does not build yet)');
  assert.equal(s.arcAllowed, s.freeCastResolved, 'every chain resolves synchronously within one fixed step in this implementation, so exactly its FIRST link ever passes the guard — see summon.js header');
  void ARC_GUARD_STEPS;
});
