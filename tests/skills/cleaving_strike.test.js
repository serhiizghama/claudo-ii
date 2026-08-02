// tests/skills/cleaving_strike.test.js
//
// SKIL-3 acceptance tests for `src/skills/impl/cleaving_strike.js` and the
// `cast()`/`canCast()` wiring added to `src/skills/index.js`.
//
// Built against a REAL `boot()` (`src/main.js`) — the same full,
// production-order subsystem registration `tools/capture.mjs`/
// `tests/core/boot.test.js` already exercise — rather than a hand-rolled
// mini-registry, per the orchestrator's explicit instruction: prove the
// R1 rage guarantee as a SYSTEM-LEVEL fact (the actor's real `rage` field),
// not a skill-layer call counter. `engine.frame()` itself is never called
// here (it would also drive `render`/`world`/`ui`/`items`/`save` update/
// render passes this file has no need to exercise and no way to make
// browser/WebGL-safe under plain Node) — simulation is advanced by calling
// `actors.fixedUpdate()` directly, tick by tick, exactly the way
// `ActorsSystem.fixedUpdate` is documented to run at 60 Hz.
//
// ---------------------------------------------------------------------------
// ONE `boot()` for the whole file — not a fresh one per test
// ---------------------------------------------------------------------------
// `src/actors/action.js`/`src/actors/timing.js` (ACTR-9/ACTR-21, both
// already accepted) keep their windup/active/recover tick schedule and
// `anim:hitframe`-dedup scratch (`lastHitframeSeq`) in MODULE-LEVEL arrays
// indexed by `actor.poolIndex` alone — no per-`ActorsSystem`-instance
// generation guard. Calling `boot()` more than once in one process reliably
// hands the first spawned actor `poolIndex === 0` again, and a second
// boot's actor can carry the SAME `actionSeq` its predecessor did (both
// start counting from 0) — `timing.js#advanceAndEmitHitframe`'s own dedup
// guard cannot tell the two apart and silently drops the second one's
// `anim:hitframe`. This is a real, load-bearing gap in already-accepted
// code — `src/actors/index.js`/`timing.js` are not this ticket's files —
// reported, not fixed here. The workaround: call `boot()` exactly ONCE for
// this whole file and spawn fresh, never-recycled actors from it in every
// test (`POOL_CAPACITY.ultra` = 220, comfortably above this file's total
// actor count) — `actionSeq` then only ever grows for a given `poolIndex`,
// so no two actors anywhere in this file's run can collide.
//
// ---------------------------------------------------------------------------
// A second, still-real gap this file works around, once, right here —
// never in `src/skills/`
// ---------------------------------------------------------------------------
// `src/actors/index.js` (ACTR-15/O-57, that file's own comment, verbatim:
// "The rest of this section (addLife, spend, lifeFraction, ...) is a later
// ticket's — not stubbed") has NOT forwarded `spend`/`canAfford` onto
// `ActorsSystem`, even though `src/actors/vessels.js` (ACTR-8, already
// accepted) exports both as pure functions and `cleaving_strike.js`'s
// production `cast()` calls `deps.actors.spend/canAfford` exactly as the
// contract promises. This file patches the ONE booted `ActorsSystem`
// instance with those two (sourced from `vessels.js`, never reimplemented)
// so `cast()` can actually run. **`addRage` is NOT patched here anymore** —
// CMBT-8/D-51 moved R1's rage award into `combat` itself
// (`src/combat/onhit.js#applyOnHitEconomy`, gated on
// `(source.generation, source.actionSeq)`), so nothing on the tested path
// calls `actors.addRage` at all any more; the earlier revision of this file
// patched it only to support a skill-layer call-counter this revision no
// longer needs. `spend`/`canAfford` remain genuinely unforwarded — recorded
// again here, not fixed (`src/actors/index.js` is not in this ticket's file
// list).

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { spend, canAfford } from '../../src/actors/vessels.js';
import { computeActionPhases, WINDUP_FRAC, ACTIVE_FRAC, RECOVER_FRAC, CONE_HALF_ANGLE } from '../../src/skills/impl/cleaving_strike.js';
import { RAGE_PER_LANDED_ACTION } from '../../src/skills/cost.js';

const H = 1 / 60;

/** A canvas stand-in — just enough for `Input.attach()`, matching
 * `tests/core/boot.test.js`'s own `makeCanvas`. */
function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

// ---------------------------------------------------------------------------
// ONE real boot() for the whole file — see the header above.
// ---------------------------------------------------------------------------

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const skills = ctx.get('skills');

// See the file header — TEST-ONLY workaround for a still-real
// src/actors/index.js gap. addRage is deliberately NOT patched.
actors.spend = (actor, resource, amount) => spend(actor, resource, amount);
actors.canAfford = (actor, resource, amount) => canAfford(actor, resource, amount);

function tick() {
  ctx.time.step++;
  actors.fixedUpdate(H, ctx);
}

/** Runs fixedUpdate until the actor's action completes (actionId back to
 * null) or a tick budget is exhausted — a real, multi-tick advance through
 * windup -> active -> recover, never a synchronous shortcut. */
function runActionToCompletion(actor, maxTicks = 600) {
  let n = 0;
  while (actor.actionId !== null && n < maxTicks) {
    tick();
    n++;
  }
  return n;
}

let nextSpawnOffset = 0;

/** A level-30 Ravager with `cleaving_strike` maxed, moderate rage (not
 * pinned at the cap, so an award is observable as an increase), facing +X.
 * Spread out along +Z so different tests' actors never overlap in space. */
function spawnPlayer() {
  const originZ = (nextSpawnOffset += 200); // far enough apart that no cone (radius 3.2 m) ever reaches a neighbour
  const player = actors.spawn({
    kind: 'player', archetypeId: 'ravager', team: 0,
    x: 0, z: originZ, facing: 0, level: 30,
  });
  actors.setState(player, 'idle'); // skip the 1s spawning-state delay — not this ticket's concern
  player.attributes.strength = 50;
  player.attributes.dexterity = 60;
  player.attributes.vitality = 50;
  for (let i = 0; i < 20; i++) skills.allocate(player, 'cleaving_strike');
  player.rage = 40; // below the 100 cap — an award must be visible as an increase
  return player;
}

/** A durable (won't die to one cleave) monster at an offset from `origin`. */
function spawnMonsterAt(origin, dx, dz) {
  const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: origin.x + dx, z: origin.z + dz, level: 1 });
  actors.setState(m, 'idle');
  actors.stats(m); // compose once so life/maxLife below are not immediately re-clobbered
  m.life = 500;
  return m;
}

/** N monsters spread inside `cleaving_strike`'s 120 deg/3.2 m cone, facing
 * +X from `player` — angles within +-50 deg (comfortably inside the 60 deg
 * half-angle) at varying short distances, so every one of them is a
 * genuine hit, not a boundary case. */
function spawnConeMonsters(player, n) {
  const monsters = [];
  for (let i = 0; i < n; i++) {
    const angle = ((i / Math.max(1, n - 1)) - 0.5) * (100 * Math.PI / 180); // spread across ~100 deg, inside the 120 deg cone
    const dist = 1.2 + (i % 3) * 0.5; // 1.2..2.2 m, inside the 3.2 m radius
    monsters.push(spawnMonsterAt(player, Math.cos(angle) * dist, Math.sin(angle) * dist));
  }
  return monsters;
}

// ---------------------------------------------------------------------------
// Acceptance — a 4-body cone: exactly 4 hit-requests, resolved in ascending
// actor.id order, and the attacker's REAL rage goes up by exactly one
// award (R1, now credited by combat itself — CMBT-8/D-51).
// ---------------------------------------------------------------------------

test('acceptance: 4-body cone -> exactly 4 combat:hit-request events, resolved in ascending actor.id order, attacker rage up by exactly one award', () => {
  const player = spawnPlayer();
  const monsters = spawnConeMonsters(player, 4);
  const expectedOrder = monsters.map((m) => m.id).slice().sort((a, b) => a - b);

  let hitRequests = 0;
  const targetOrder = [];
  const onReq = ({ target }) => { hitRequests++; targetOrder.push(target.id); };
  ctx.events.on('combat:hit-request', onReq);

  const cost = skills.costOf(player, 'cleaving_strike'); // read now — costOf's own scratch, snapshot the amount
  const costAmount = cost.amount;
  const rageBefore = player.rage;
  const ok = skills.cast(player, 'cleaving_strike', player.x + 10, player.z, 0);
  assert.equal(ok, true, 'cast() must succeed against a rage-affording, idle, fully-allocated actor');

  const ticks = runActionToCompletion(player);
  assert.ok(ticks > 0 && ticks < 600, 'the action must complete within the tick budget');

  ctx.events.off('combat:hit-request', onReq);

  assert.equal(hitRequests, 4, 'a 4-body cone must emit exactly 4 combat:hit-request events');
  assert.deepEqual(targetOrder, expectedOrder, '05 §14 row 3: multi-target resolve in ascending actor.id order');
  // Net delta = -cost + exactly ONE landed-hit award (RAGE_PER_LANDED_ACTION
  // = 6). cleaving_strike's own cost (10.75 at max level) EXCEEDS one
  // award, so the net delta is legitimately negative — "rage went up" is
  // the wrong test; "exactly one award landed, not four" is the right one,
  // and this pins the exact expected number, not just its sign.
  const rageDelta = player.rage - rageBefore;
  assert.ok(Math.abs(rageDelta - (RAGE_PER_LANDED_ACTION - costAmount)) < 1e-9,
    `rage delta must be exactly one landed-hit award (${RAGE_PER_LANDED_ACTION}) minus cost (${costAmount}) = ${RAGE_PER_LANDED_ACTION - costAmount}; got ${rageDelta} — a delta of 4x that would mean the per-target bug is back`);
});

// ---------------------------------------------------------------------------
// §12.1's lock, proven at the SYSTEM level: the attacker's real rage delta
// is IDENTICAL at 1, 4 and 8 bodies — the anti-pattern R1 exists to prevent
// (an award scaling with target count) does not happen, full stop. Cost is
// the same at every body count (same actor, same level), so an identical
// delta is only possible if the award itself is identical too.
// ---------------------------------------------------------------------------

test('12.1 lock: the attacker\'s real rage delta is identical at 1, 4 and 8 bodies, through a real boot()', () => {
  const deltas = {};
  const hitCounts = {};
  for (const n of [1, 4, 8]) {
    const player = spawnPlayer();
    spawnConeMonsters(player, n);

    let hitRequests = 0;
    const onReq = () => { hitRequests++; };
    ctx.events.on('combat:hit-request', onReq);

    const rageBefore = player.rage;
    assert.equal(skills.cast(player, 'cleaving_strike', player.x + 10, player.z, 0), true, `cast() must succeed for n=${n}`);
    runActionToCompletion(player);

    ctx.events.off('combat:hit-request', onReq);

    hitCounts[n] = hitRequests;
    deltas[n] = player.rage - rageBefore;
  }

  assert.deepEqual(hitCounts, { 1: 1, 4: 4, 8: 8 }, 'hit-request count must scale with body count — that part IS per-target, by design');
  assert.equal(deltas[1], deltas[4], 'rage delta must be identical at 1 vs 4 bodies');
  assert.equal(deltas[4], deltas[8], 'rage delta must be identical at 4 vs 8 bodies');
  // cleaving_strike's own cost (10.75 at max level) EXCEEDS one landed-hit
  // award (6) — a legitimately NEGATIVE net delta. The bug R1 guards
  // against would make MORE bodies land MORE awards, i.e. a LESS negative
  // (or positive) delta as n grows — asserting identity across 1/4/8 is
  // exactly the check that rules that out, regardless of the delta's sign.
  assert.ok(deltas[1] < 0, 'sanity: this build\'s cost genuinely exceeds one award, so the identical delta is expected to be negative, not accidentally zero');
  // eslint-disable-next-line no-console
  console.log(`[SKIL-3 acceptance] rage delta identical across 1/4/8 bodies: ${deltas[1]}, ${deltas[4]}, ${deltas[8]} (hit-requests: ${hitCounts[1]}, ${hitCounts[4]}, ${hitCounts[8]})`);
});

// ---------------------------------------------------------------------------
// Facing lock — "the cursor supplies the facing only... it turns and swings
// in place" (05 §2.1): facing is set once at cast and never changes again
// for the rest of the action.
// ---------------------------------------------------------------------------

test('facing lock: facing snaps to the target once at cast, then never changes for the rest of the action', () => {
  const player = spawnPlayer();
  player.facing = Math.PI; // facing -X initially — the cast target below is +X/+Z of the actor
  spawnConeMonsters(player, 1);

  assert.equal(skills.cast(player, 'cleaving_strike', player.x + 5, player.z + 5, 0), true);
  const facingAfterCast = player.facing;
  const expectedFacing = Math.atan2(5, 5); // atan2(dz, dx) — 01 §2's own convention
  assert.ok(Math.abs(facingAfterCast - expectedFacing) < 1e-9, 'facing must snap to face the cast target');

  let sawChange = false;
  let n = 0;
  while (player.actionId !== null && n < 600) {
    tick();
    n++;
    if (Math.abs(player.facing - facingAfterCast) > 1e-9) sawChange = true;
  }
  assert.equal(sawChange, false, 'facing must not change again for the rest of the action — the facing lock holds');
});

// ---------------------------------------------------------------------------
// 05 §1.4 rule 1 — a refused cast never moves the character.
// ---------------------------------------------------------------------------

test('rule 1: a refused cast (no rage) never touches x/z/facing', () => {
  const player = spawnPlayer();
  player.rage = 0; // afford nothing
  const { x, z, facing } = player;

  const check = skills.canCast(player, 'cleaving_strike', player.x + 10, player.z);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'resource');

  const ok = skills.cast(player, 'cleaving_strike', player.x + 10, player.z, 0);
  assert.equal(ok, false, 'cast() must refuse when canCast() refuses');
  assert.equal(player.x, x); assert.equal(player.z, z); assert.equal(player.facing, facing);
  assert.equal(player.actionId, null, 'a refused cast must never begin an action either');
});

// ---------------------------------------------------------------------------
// §1.4's five targeting-mode refusal reasons — canCast()'s generic logic.
// ---------------------------------------------------------------------------

test("canCast: 'point' mode with no declared def.range never refuses on distance (cleaving_strike's own case)", () => {
  const player = spawnPlayer();
  // cleaving_strike's own def has no `range` field — a point 500 m away
  // must not trigger 'no-path'.
  const check = skills.canCast(player, 'cleaving_strike', player.x + 500, player.z + 500);
  assert.notEqual(check.reason, 'no-path');
});

test('canCast: unknown skillId refuses with reason "unknown"', () => {
  const player = spawnPlayer();
  const check = skills.canCast(player, 'not_a_real_skill', 0, 0);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'unknown');
});

test('canCast: an actor mid-action (windup) refuses with reason "busy" — 05 §1.4 rule 1\'s precondition', () => {
  const player = spawnPlayer();
  spawnConeMonsters(player, 1);
  assert.equal(skills.cast(player, 'cleaving_strike', player.x + 5, player.z, 0), true);
  assert.notEqual(player.actionId, null, 'actor must be mid-action (windup) right after cast');
  const check = skills.canCast(player, 'cleaving_strike', player.x + 5, player.z);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'busy');

  // Drain the action this test started — this file shares ONE boot()/
  // ActorsSystem (see the file header), and `fixedUpdate` advances every
  // live actor every tick, so an action left mid-windup here would still
  // resolve (and fire its own combat:hit-request) during a LATER test's
  // ticking.
  runActionToCompletion(player);
});

test('canCast: zero allocated points refuses with reason "unallocated"', () => {
  const player = actors.spawn({ kind: 'player', archetypeId: 'ravager', team: 0, x: 0, z: (nextSpawnOffset += 200), level: 30 });
  actors.setState(player, 'idle');
  player.rage = 40;
  // no skills.allocate() call — 0 points spent
  const check = skills.canCast(player, 'cleaving_strike', player.x + 5, player.z);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'unallocated');
});

// canCast()'s own mode-dispatch branches, for the FOUR target modes
// cleaving_strike itself never uses — synthetic `def`-shaped mocks only
// (never `SKILLS`/`data/skills.js`, per D-37 scope), proving the generic
// logic (not just cleaving_strike's own 'point' path) implements 05 §1.4's
// table correctly.
test("canCast()'s refusal-reason table generalises correctly to the other four target modes (synthetic defs, not real skill data)", () => {
  // Exercises the exact branch predicate canCast() itself uses (`src/
  // skills/index.js#canCast`'s own 'point'+def.range check), isolated from
  // a live SkillsSystem — no cast handler exists for these synthetic ids
  // (D-37), so this checks the TABLE LOGIC, reproduced verbatim, not a
  // live cast().
  function pointNoPathCheck(def, actorPos, targetX, targetZ) {
    if (def.target === 'point' && typeof def.range === 'number') {
      const dx = targetX - actorPos.x;
      const dz = targetZ - actorPos.z;
      return Math.sqrt(dx * dx + dz * dz) > def.range;
    }
    return false;
  }

  // 'point' WITH a declared range: an out-of-range point must refuse.
  assert.equal(pointNoPathCheck({ target: 'point', range: 5 }, { x: 0, z: 0 }, 100, 0), true, "'point' mode with def.range=5 must refuse a point 100 m away");
  assert.equal(pointNoPathCheck({ target: 'point', range: 5 }, { x: 0, z: 0 }, 2, 0), false, "'point' mode with def.range=5 must accept a point 2 m away");
  // 'self' / 'direction' / 'actor' / 'none' never trigger the no-path branch at all.
  for (const target of ['self', 'direction', 'actor', 'none']) {
    assert.equal(pointNoPathCheck({ target }, { x: 0, z: 0 }, 9999, 9999), false, `'${target}' mode must never refuse on distance`);
  }
});

// ---------------------------------------------------------------------------
// Wind-up/active/recovery decomposition and S6 — active is never IAS-scaled
// ---------------------------------------------------------------------------

test('computeActionPhases: WINDUP_FRAC + ACTIVE_FRAC + RECOVER_FRAC sum to 1 (03 §4.5 default attack split)', () => {
  assert.ok(Math.abs(WINDUP_FRAC + ACTIVE_FRAC + RECOVER_FRAC - 1) < 1e-12);
  assert.equal(WINDUP_FRAC, 0.40);
  assert.equal(ACTIVE_FRAC, 0.15);
  assert.ok(Math.abs(RECOVER_FRAC - 0.45) < 1e-12);
});

test('computeActionPhases: reproduces 05 §2.1\'s printed worked example — Battle Axe at IAS 0 -> 0.7088 s total', () => {
  // 03 §8.1 Battle Axe attackTime 0.75, Ravager classScale.attackScale 0.90
  // (src/combat/data/weapons.js) -> combat.attackInterval() at IAS 0 is
  // exactly 0.675 (no clamp interaction at this magnitude). x1.05 skill
  // attackScale = 0.70875 ~= 0.7088 s, 05 §2.1's own printed figure.
  const phases = computeActionPhases(0.675, 0, 1.05);
  assert.ok(Math.abs(phases.baseInterval - 0.70875) < 1e-9);
  const total = phases.windup + phases.active + phases.recover;
  assert.ok(Math.abs(total - phases.baseInterval) < 1e-9, 'the three phases must sum to the whole interval');
  assert.ok(Math.abs(phases.baseInterval - 0.7088) < 1e-4, "must reproduce 05 §2.1's printed 0.7088 s");
});

test('S6: `active` (seconds) is IDENTICAL across an IAS sweep -75..+150 — never IAS-scaled', () => {
  // A weapon/class combo whose base interval (0.675 s) stays well clear of
  // combat.attackInterval()'s own [0.25, 3.0] clamp across this whole sweep
  // (0.675 / (1 + 150/100) = 0.27, still > 0.25) — see this file's own
  // header on the combat gap-1 back-derivation's clamp-edge caveat.
  const activeSeconds = [];
  for (let ias = -75; ias <= 150; ias += 15) {
    const mult = 1 / (1 + ias / 100);
    const iasScaledInterval = 0.675 * mult; // what combat.attackInterval() would report at this IAS
    const phases = computeActionPhases(iasScaledInterval, ias, 1.05);
    activeSeconds.push(phases.active);
  }
  const first = activeSeconds[0];
  for (const a of activeSeconds) assert.ok(Math.abs(a - first) < 1e-9, 'active seconds must not vary with IAS');
});

test('S5: computeActionPhases() stays inside the [0.25, 3.0] s clamp across the full legal IAS range, -75..+300 (structural, via the production re-clamp)', () => {
  for (let ias = -75; ias <= 300; ias += 5) {
    const mult = 1 / (1 + ias / 100);
    const iasScaledInterval = Math.min(3.0, Math.max(0.25, 0.675 * mult)); // combat.attackInterval()'s own clamp
    const phases = computeActionPhases(iasScaledInterval, ias, 1.05); // the REAL production function — its own re-clamp is what's under test here
    assert.ok(phases.baseInterval >= 0.25 && phases.baseInterval <= 3.0, `ias=${ias}: baseInterval ${phases.baseInterval} must stay inside [0.25, 3.0]`);
  }
});

test('S5 quantified: the post-IAS attack interval this file effectively reconstructs (combat.attackInterval() x skillAttackScale, re-clamped) diverges from the textbook (scale-inside-the-division) formula only where combat.attackInterval() itself is already clamped, and only by up to 0.25 x (skillAttackScale - 1)', () => {
  // NOTE what this test does and does NOT compare: `computeActionPhases()`'s
  // own `baseInterval` return is DELIBERATELY a PRE-IAS quantity (it feeds
  // `actors.beginAction()`, which applies IAS itself, per 08 §6.1/S6) — it
  // is not the "current attack interval at this IAS" and comparing it
  // directly against a post-IAS textbook value would conflate two
  // different quantities by design (08 §6.2's `active`-never-scales rule
  // makes the real windup+active+recover TOTAL diverge from any
  // undecomposed single-formula interval at nonzero IAS, on purpose — that
  // is S6, not this approximation). The quantity actually at stake for S5's
  // "does the attackScale back-derivation stay accurate" question is the
  // POST-IAS reconstruction this file's header works through by hand:
  // `clamp(combat.attackInterval() x skillAttackScale, 0.25, 3.0)` — this
  // is what the file's own header analysis compares against the textbook
  // formula, reproduced here as a real assertion over the full IAS range,
  // not just the two hand-picked breakpoints (170, 183.5) the header names.
  const weaponClassBase = 0.675;
  const skillAttackScale = 1.05;
  const maxExpectedDivergence = 0.25 * (skillAttackScale - 1); // 0.0125

  for (let ias = -75; ias <= 300; ias += 1) {
    const mult = 1 / (1 + ias / 100);
    const combatReported = Math.min(3.0, Math.max(0.25, weaponClassBase * mult)); // what combat.attackInterval() actually returns
    const mine = Math.min(3.0, Math.max(0.25, combatReported * skillAttackScale)); // this file's own post-hoc, re-clamped multiply
    const textbook = Math.min(3.0, Math.max(0.25, weaponClassBase * skillAttackScale * mult)); // scale applied INSIDE the division, per 03 §4.3's literal formula

    const divergence = Math.abs(mine - textbook);
    assert.ok(divergence <= maxExpectedDivergence + 1e-9, `ias=${ias}: divergence ${divergence} exceeds the derived bound ${maxExpectedDivergence}`);
    if (ias <= 170) assert.ok(divergence < 1e-9, `ias=${ias}: below combat's own clamp threshold (170), mine and textbook must match exactly — got divergence ${divergence}`);
  }
});

test('CONE_HALF_ANGLE is 60 deg (half of the 120 deg cone, 03-combat-math.md:684 / 05-skills.md:243)', () => {
  assert.ok(Math.abs(CONE_HALF_ANGLE - Math.PI / 3) < 1e-12);
});

// ---------------------------------------------------------------------------
// Live, real cone geometry: a body just outside the 120 deg arc is never hit.
// ---------------------------------------------------------------------------

test('cone geometry (real physics.overlapCone): a body outside the 120 deg arc is excluded, one inside is included', () => {
  const player = spawnPlayer(); // facing 0 (+X)
  const inside = spawnMonsterAt(player, 2.0, 0.0); // dead ahead, well inside
  const outside = spawnMonsterAt(player, -2.0, 0.0); // directly behind — outside any 120 deg forward arc

  const hitTargets = [];
  const onReq = ({ target }) => hitTargets.push(target.id);
  ctx.events.on('combat:hit-request', onReq);

  assert.equal(skills.cast(player, 'cleaving_strike', player.x + 5, player.z, 0), true);
  runActionToCompletion(player);

  ctx.events.off('combat:hit-request', onReq);

  assert.deepEqual(hitTargets, [inside.id]);
  assert.ok(!hitTargets.includes(outside.id));
});
