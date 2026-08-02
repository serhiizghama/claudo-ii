// tests/skills/status.test.js
//
// SKIL-6 acceptance tests for `src/skills/status.js` and the RNG-fork wiring
// added to `src/skills/index.js`.
//
// Built against a REAL `boot()` (`src/main.js`), same precedent
// `tests/skills/cleaving_strike.test.js`/`rune_strike.test.js` already
// established: ONE boot() for the whole file (see those files' own headers
// for why — module-level `poolIndex` scratch in `src/actors/action.js`),
// fresh never-recycled actors per test, well-separated spawn coordinates.
//
// Covers: S9 (every rider a skill applies names a real status, in range),
// O-82 (every StatusSpec this file builds carries a finite step), §12.3
// (essence_burn's damagePerManaSpent is level-constant), and the general
// rider engine exercised end-to-end through the REAL `combat` pipeline for
// six of the seven "reachable status kinds" S9 names (bleeding, cursed,
// slowed, blinded, shocked, burning — `stunned`/the DR chain and `frozen`/
// chill accumulation get their own file, `tests/skills/dr_chain.test.js`,
// since they are genuinely a different mechanism).

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import {
  applyOnHitStatuses,
  buildStatusSpec,
  applyStatusSafe,
  isKnownStatus,
  isValidStatusMagnitude,
  isValidStatusDuration,
  computeEssenceBurnDamage,
  essenceBurnDamagePerManaSpent,
  ONHIT_SLOT_COUNT,
} from '../../src/skills/status.js';
// `ActorsSystem` has not forwarded `hasStatus`/`statusStacks` from
// `src/actors/status.js` onto its own public class (ACTR-20 only forwarded
// `applyStatus` — verified by reading `src/actors/index.js` directly; not
// this ticket's file to fix). Reading the pure functions directly here
// matches the established precedent `tests/combat/resolve.test.js`/
// `tests/skills/rune_strike.test.js` already set for the identical
// situation (importing an accepted sibling subsystem's internals directly
// in a TEST file — never in production code, where rule 2 applies).
import { hasStatus, statusStacks } from '../../src/actors/status.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const combat = ctx.get('combat');
const skills = ctx.get('skills');
const physics = ctx.get('physics');

/** `skills`'s own internal deps bag mirrors `_skillDeps` — rebuilt here
 * rather than reached into `skills` private state, since tests should only
 * depend on the public surface. */
function makeDeps() {
  return { actors, combat, physics, events: ctx.events, time: ctx.time, skills, rng: ctx.rng.fork() };
}

let nextSpawnOffset = 4000; // clear of every other SKIL-* test file's own spawn band

function spawnActor(classId, team) {
  const originZ = (nextSpawnOffset += 200);
  const a = actors.spawn({ kind: team === 0 ? 'player' : 'monster', archetypeId: classId, team, x: 0, z: originZ, level: 30 });
  actors.setState(a, 'idle');
  if (team === 0) {
    a.attributes.strength = 60;
    a.attributes.dexterity = 60;
    a.attributes.vitality = 60;
  }
  actors.stats(a);
  a.stats.attackRating = 9999; // near-certain to-hit — this file tests riders, not R1/R2
  a.life = 100000;
  a.stats.maxLife = 100000;
  return a;
}

function maxAllocate(actor, skillId) {
  for (let i = 0; i < 20; i++) skills.allocate(actor, skillId);
}

/** Resolves `skillId` from `source` at `level` against `target` through the
 * REAL combat pipeline, retrying a few times against combat's own forked
 * (but deterministic-seed) stream until a hit actually lands — `source`'s
 * `attackRating` above is already stacked heavily in the attacker's favour,
 * so this rarely needs more than one draw; the retry only exists so a
 * single unlucky deterministic draw never makes the file flaky.
 * @returns {{def:object, packet:object, result:object}}
 */
function resolveOnce(buildFn, source, target, skillId, level) {
  const def = skills.definition(skillId);
  for (let attempt = 0; attempt < 20; attempt++) {
    const packet = combat[buildFn](source, skillId, level);
    assert.ok(packet, 'buildFn must succeed (packet pool not exhausted)');
    packet.onHitCount = 0; // see status.js's own header — riders are applied AFTER resolve(), never before
    const result = combat.resolve(packet, target);
    if (result.outcome === 'hit') return { def, packet, result };
    combat.releasePacket(packet);
  }
  throw new Error(`resolveOnce: no hit landed for ${skillId} in 20 attempts — deterministic seed regressed`);
}

// ===========================================================================
// O-82 — buildStatusSpec throws on a non-finite step; every real application
// this file performs ends with a finite expiresStep
// ===========================================================================

test('O-82: buildStatusSpec refuses a StatusSpec with a missing/non-finite step', () => {
  assert.throws(
    () => buildStatusSpec({ status: 'bleeding', sourceId: 1, sourceGen: 0, sourceSkill: 'test', element: null, magnitude: 1, duration: 1, stacks: 1 }),
    /O-82/,
    'step omitted entirely (undefined) must throw, not silently NaN expiresStep',
  );
  assert.throws(() => buildStatusSpec({ status: 'bleeding', step: NaN, magnitude: 1, duration: 1 }), /O-82/);
  assert.throws(() => buildStatusSpec({ status: 'bleeding', step: Infinity, magnitude: 1, duration: 1 }), /O-82/);
  const ok = buildStatusSpec({ status: 'bleeding', step: 42, sourceId: 0, sourceGen: 0, sourceSkill: null, element: null, magnitude: 1, duration: 1, stacks: 1 });
  assert.equal(ok.step, 42, 'a finite step passes through unmodified');
});

test('O-82: applyStatusSafe never produces a NaN expiresStep for a spec this file builds', () => {
  const target = spawnActor('emberwright', 1);
  const spec = buildStatusSpec({
    status: 'bleeding', step: ctx.time.step, sourceId: 1, sourceGen: 0, sourceSkill: 'test',
    element: null, magnitude: 5, duration: 3, stacks: 1,
  });
  const inst = applyStatusSafe(actors, target, spec);
  assert.ok(inst, 'applyStatus must succeed against a live actor');
  assert.ok(Number.isFinite(inst.expiresStep), `expiresStep must be finite, got ${inst.expiresStep}`);
  console.log(`[O-82] applied bleeding: appliedStep=${inst.appliedStep} expiresStep=${inst.expiresStep} (finite: ${Number.isFinite(inst.expiresStep)})`);
});

// ===========================================================================
// S9 — every onHitStatus rider of the ten skills this ticket owns names a
// real status, with magnitude and duration inside 01 §7's ranges, at every
// level 1..20
// ===========================================================================

const OWNED_SKILL_IDS = [
  'bloodletting', 'sunder', 'ram_charge', 'war_cry', 'flame_wave',
  'incinerate', 'ashen_step', 'essence_burn', 'blade_seal', 'thunder_step',
];

test('S9: every onHitStatus rider of the ten owned skills names a known STATUS id, in range, at L1/L10/L20', () => {
  let riderCount = 0;
  const table = [];
  for (const skillId of OWNED_SKILL_IDS) {
    const def = skills.definition(skillId);
    assert.ok(def, `${skillId} must resolve — a skill this ticket owns is missing from the registry`);
    for (const rider of def.onHitStatus) {
      riderCount++;
      assert.ok(isKnownStatus(rider.status), `S9: ${skillId} names unknown status '${rider.status}'`);
      for (const level of [1, 10, 20]) {
        const duration = rider.duration ? (rider.duration.cap !== undefined
          ? Math.min(rider.duration.base + rider.duration.perLevel * (level - 1), rider.duration.cap)
          : rider.duration.base + rider.duration.perLevel * (level - 1)) : 0;
        const magnitudeRaw = rider.magnitude ? (rider.magnitude.cap !== undefined
          ? Math.min(rider.magnitude.base + rider.magnitude.perLevel * (level - 1), rider.magnitude.cap)
          : rider.magnitude.base + rider.magnitude.perLevel * (level - 1)) : 0;
        assert.ok(isValidStatusDuration(rider.status, duration), `S9: ${skillId}/${rider.status} L${level} duration ${duration} out of range`);
        assert.ok(isValidStatusMagnitude(rider.status, magnitudeRaw), `S9: ${skillId}/${rider.status} L${level} magnitude ${magnitudeRaw} out of range`);
        table.push({ skillId, status: rider.status, level, magnitude: magnitudeRaw, duration });
      }
    }
  }
  assert.ok(riderCount >= 8, `expected at least 8 riders across the ten owned skills, got ${riderCount}`);

  console.log('[S9] status | skill | level | magnitude | duration | 01 §7 range checked against');
  for (const row of table) {
    console.log(`  ${row.status.padEnd(9)} | ${row.skillId.padEnd(13)} | L${String(row.level).padEnd(2)} | mag=${row.magnitude.toFixed(3).padStart(8)} | dur=${row.duration.toFixed(3).padStart(7)}s`);
  }

  // The seven reachable status kinds named by 05 §14 row 6.
  const kinds = new Set(table.map((r) => r.status));
  kinds.add('frozen'); // reached via blade_seal's cold-imbue chill accumulation, not an onHitStatus rider — proven in dr_chain.test.js's E8.1 reproduction
  const expectedSeven = ['bleeding', 'cursed', 'stunned', 'shocked', 'slowed', 'blinded', 'frozen'];
  for (const k of expectedSeven) assert.ok(kinds.has(k), `S9: the seven reachable status kinds must include '${k}', got ${[...kinds].join(',')}`);
  console.log(`[S9] seven reachable status kinds covered: ${expectedSeven.join(', ')}`);
});

// ===========================================================================
// §12.3 — essence_burn: damagePerManaSpent is constant to within 1e-9 across
// spends of 20, 100 and 354 mana, at every level; manaCostReduction never
// enters this formula at all (it is not a parameter of it).
// ===========================================================================

test('§12.3: essence_burn damagePerManaSpent is constant across spends of 20/100/354 mana, at every level', () => {
  const def = skills.definition('essence_burn');
  assert.ok(def, 'essence_burn must resolve');
  const spends = [20, 100, 354];

  console.log('[§12.3] level | damagePerManaSpent | damage@20 | damage@100 | damage@354 | max deviation');
  let maxDeviation = 0;
  for (const level of [1, 5, 10, 15, 20]) {
    const expected = essenceBurnDamagePerManaSpent(def, level);
    const ratios = spends.map((mana) => computeEssenceBurnDamage(def, level, mana) / mana);
    const dev = Math.max(...ratios.map((r) => Math.abs(r - expected)));
    maxDeviation = Math.max(maxDeviation, dev);
    const damages = spends.map((mana) => computeEssenceBurnDamage(def, level, mana));
    console.log(`  L${String(level).padEnd(2)} | ${expected.toFixed(6).padStart(10)} | ${damages.map((d) => d.toFixed(3)).join(' | ')} | dev=${dev.toExponential(3)}`);
    for (const r of ratios) assert.ok(Math.abs(r - expected) < 1e-9, `L${level}: damagePerManaSpent drifted by ${Math.abs(r - expected)}`);
  }
  console.log(`[§12.3] max deviation across all levels/spends: ${maxDeviation.toExponential(3)} (must be < 1e-9)`);
  assert.ok(maxDeviation < 1e-9, `max deviation ${maxDeviation} must be < 1e-9`);

  // L20's own printed reference: 20 mana -> 20 x 3.76 = 75.2 damage (05 §12.3: "pays spentMana x 3.76 at level 20 ... receives 75 damage").
  const l20 = computeEssenceBurnDamage(def, 20, 20);
  console.log(`[§12.3] L20 @ 20 mana: got ${l20.toFixed(4)}, spec text says "75" (rounded from the exact 75.2000 the 3.76 coefficient gives)`);
  assert.ok(Math.abs(l20 - 75.2) < 1e-9, 'L20 factor must be exactly 3.76 (1.10 + 0.14x19)');

  // manaCostReduction has NO parameter anywhere in this formula — structural
  // proof, not just an empirical one: computeEssenceBurnDamage's signature
  // is (def, level, spentMana), nothing else, so there is no argument slot
  // through which a reduction stat could reach it.
  assert.equal(computeEssenceBurnDamage.length, 3, 'no manaCostReduction parameter exists on this function at all');
});

// ===========================================================================
// The rider engine, through the REAL combat pipeline — six of the seven
// status kinds (stunned/frozen have their own file, dr_chain.test.js)
// ===========================================================================

test('rider engine: bloodletting -> bleeding, independent stacks to 5, coefficient x result.physical', () => {
  const player = spawnActor('ravager', 0);
  maxAllocate(player, 'bloodletting');
  const target = spawnActor('emberwright', 1);
  target.stats.defense = 0;
  const level = skills.effectiveLevel(player, 'bloodletting');
  const deps = makeDeps();

  for (let i = 0; i < 5; i++) {
    const { def, packet, result } = resolveOnce('buildAttackPacket', player, target, 'bloodletting', level);
    assert.ok(result.physical > 0, 'a landed bloodletting hit must deal physical damage');
    applyOnHitStatuses(deps, def, level, packet, target, result, ctx.time.step);
    combat.releasePacket(packet);
  }

  assert.equal(statusStacks(target, 'bleeding'), 5, 'five independent applications must cap at exactly 5 stacks (01 §7.2)');
  const bleeds = target.statuses.filter((s) => s.status === 'bleeding');
  console.log(`[bleeding] ${bleeds.length} independent instances, magnitudes: ${bleeds.map((b) => b.magnitude.toFixed(3)).join(', ')}`);
  for (const b of bleeds) {
    assert.ok(Number.isFinite(b.expiresStep), 'O-82: every instance must have a finite expiresStep');
    assert.ok(b.magnitude > 0, 'bleeding magnitude must be coefficient x dealt damage, never 0');
  }
});

test('rider engine: sunder -> cursed, fixed magnitude, real DR-chain-adjacent path (applyStatusFromPacket)', () => {
  const player = spawnActor('ravager', 0);
  maxAllocate(player, 'sunder');
  const target = spawnActor('emberwright', 1);
  target.stats.defense = 0;
  const level = skills.effectiveLevel(player, 'sunder');
  const deps = makeDeps();

  const { def, packet, result } = resolveOnce('buildAttackPacket', player, target, 'sunder', level);
  applyOnHitStatuses(deps, def, level, packet, target, result, ctx.time.step);
  combat.releasePacket(packet);

  assert.ok(hasStatus(target, 'cursed'), 'sunder must apply cursed');
  const inst = target.statuses.find((s) => s.status === 'cursed');
  console.log(`[cursed] magnitude=${inst.magnitude} duration=${((inst.expiresStep - inst.appliedStep) / 60).toFixed(3)}s`);
  // 05 §2.5: magnitude = 40 + 1x(slvl-1), capped 70; L20 -> 59.
  assert.ok(Math.abs(inst.magnitude - 59) < 1e-6, `L20 cursed magnitude must be 59, got ${inst.magnitude}`);
  assert.ok(Number.isFinite(inst.expiresStep));
});

test('rider engine: ashen_step -> slowed + blinded, zero-damage attackRating=0 packet lands riders without a to-hit roll', () => {
  const player = spawnActor('emberwright', 0);
  maxAllocate(player, 'ashen_step');
  const target = spawnActor('ravager', 1);
  const level = skills.effectiveLevel(player, 'ashen_step');
  const deps = makeDeps();
  const def = skills.definition('ashen_step');

  const packet = combat.scratchPacket();
  packet.sourceId = player.id; packet.sourceGen = player.generation; packet.sourceSkillId = 'ashen_step'; packet.sourceLevel = level;
  packet.team = player.team;
  packet.attackRating = 0; packet.blockable = false; packet.dodgeable = false;
  packet.onHitCount = 0;
  const result = combat.resolve(packet, target);
  assert.equal(result.outcome, 'hit', 'attackRating=0 must always hit, per 01 §8.1');
  assert.equal(result.total, 0, 'ashen_step deals zero damage at every level (05 §5.1)');

  applyOnHitStatuses(deps, def, level, packet, target, result, ctx.time.step);
  combat.releasePacket(packet);

  assert.ok(hasStatus(target, 'slowed'), 'ashen_step must apply slowed');
  assert.ok(hasStatus(target, 'blinded'), 'ashen_step must apply blinded');
  const slowed = target.statuses.find((s) => s.status === 'slowed');
  const blinded = target.statuses.find((s) => s.status === 'blinded');
  console.log(`[slowed] magnitude=${slowed.magnitude} (expect 59 @ L20, cap 60)`);
  console.log(`[blinded] magnitude=${blinded.magnitude} (expect 60, fixed)`);
  assert.ok(Math.abs(slowed.magnitude - 59) < 1e-6);
  assert.ok(Math.abs(blinded.magnitude - 60) < 1e-6);
});

test('rider engine: thunder_step -> shocked, fixed rider, magnitude 0 (the +12%/stack figure belongs to the status itself, not the rider)', () => {
  const player = spawnActor('runeblade', 0);
  maxAllocate(player, 'thunder_step');
  const target = spawnActor('ravager', 1);
  target.stats.defense = 0;
  const level = skills.effectiveLevel(player, 'thunder_step');
  const deps = makeDeps();

  const { def, packet, result } = resolveOnce('buildSpellPacket', player, target, 'thunder_step', level);
  applyOnHitStatuses(deps, def, level, packet, target, result, ctx.time.step);
  combat.releasePacket(packet);

  assert.ok(hasStatus(target, 'shocked'), 'thunder_step must apply shocked');
  const inst = target.statuses.find((s) => s.status === 'shocked');
  console.log(`[shocked] stacks=${inst.stacks} duration=${((inst.expiresStep - inst.appliedStep) / 60).toFixed(3)}s`);
  assert.equal(inst.stacks, 1);
});

test('rider engine: flame_wave -> burning, coefficient x result.fire (0.45), 4.0s duration override', () => {
  const player = spawnActor('emberwright', 0);
  maxAllocate(player, 'flame_wave');
  const target = spawnActor('ravager', 1);
  target.stats.fireResist = 0;
  const level = skills.effectiveLevel(player, 'flame_wave');
  const deps = makeDeps();

  // CMBT-10/D-59: `combat.buildSpellPacket()` now reads a skill's own
  // `def.flatDamage` directly (`src/combat/packet.js`'s `stepB7`, wired by
  // that ticket — the file header's former "gap 1" note this comment used to
  // cite is closed for exactly this case: `flame_wave`'s `element` is
  // `'fire'`, a static, non-cast-time-chosen value). The manual equipment-
  // layer `fireMin`/`fireMax` stand-in this test used before (mirroring
  // `tests/skills/rune_strike.test.js`'s own Part 1 technique for
  // `blade_seal`'s STILL-open gap — that skill's imbue element is chosen at
  // cast time, so it cannot be resolved by `combat`'s static per-skill
  // lookup) is no longer needed: `flame_wave`'s own L20 `flatDamage` now
  // reaches `packet.fireMin`/`fireMax` through the real pipeline.
  const { def, packet, result } = resolveOnce('buildSpellPacket', player, target, 'flame_wave', level);
  assert.ok(result.fire > 0, 'a landed flame_wave hit must deal fire damage');
  applyOnHitStatuses(deps, def, level, packet, target, result, ctx.time.step);
  combat.releasePacket(packet);

  assert.ok(hasStatus(target, 'burning'), 'flame_wave must seed burning');
  const inst = target.statuses.find((s) => s.status === 'burning');
  // 03 §7.4: "Magnitude | damage per second | ... Skill override | flame_wave
  // seeds x0.45 over 4.0s" — the coefficient x dealt is a TOTAL spread over
  // the 4.0s override, so the per-second magnitude the engine ticks against
  // is that total DIVIDED by 4.0, not the bare product. This assertion used
  // to read `0.45 * result.fire` (no division) — that encoded the same
  // 4x-too-strong defect `src/skills/status.js#applyCoefficientRider` has
  // just been fixed for (grant from the coordinator, this session): a real
  // cast dealt 4x the intended burn total over its 4s duration.
  const expectedMagnitude = (0.45 * result.fire) / 4.0;
  console.log(`[burning] result.fire=${result.fire.toFixed(4)} magnitude=${inst.magnitude.toFixed(4)} expected=${expectedMagnitude.toFixed(4)} duration=${((inst.expiresStep - inst.appliedStep) / 60).toFixed(3)}s`);
  assert.ok(Math.abs(inst.magnitude - expectedMagnitude) < 1e-9, 'burning magnitude must be exactly (0.45 x result.fire) / 4.0 (flame_wave overrides the default 0.35/3.0s to 0.45/4.0s, and the coefficient is a TOTAL over that window, 03 §7.4)');
  assert.ok(Math.abs((inst.expiresStep - inst.appliedStep) / 60 - 4.0) < 1 / 60);
});

test('ONHIT_SLOT_COUNT matches the packet pool contract (4)', () => {
  assert.equal(ONHIT_SLOT_COUNT, 4);
});
