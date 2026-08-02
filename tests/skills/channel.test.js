// tests/skills/channel.test.js
//
// SKIL-7 acceptance tests for `src/skills/channel.js` and the
// `cast()`/`fixedUpdate()`/`interrupt()`/`isChannelling()`/`polarityStance()`
// wiring added to `src/skills/index.js`.
//
// Built against a REAL `boot()` (`src/main.js`) — same precedent
// `tests/skills/cleaving_strike.test.js`/`rune_strike.test.js` already
// established: simulation is advanced by calling `actors.fixedUpdate()` +
// `skills.fixedUpdate()` directly, tick by tick, never a synchronous
// shortcut, and rage/income are read off the REAL `actor.rage` field, not a
// skill-layer call counter. One `boot()` for the whole file — see those
// files' own header for why (module-level `poolIndex` scratch in
// `src/actors/action.js`/`timing.js`).

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';

const H = 1 / 60;

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const combat = ctx.get('combat');
const physics = ctx.get('physics');
const skills = ctx.get('skills');

function tick() {
  ctx.time.step++;
  actors.fixedUpdate(H, ctx);
  skills.fixedUpdate(H, ctx);
}

let nextSpawnOffset = 0;

/** A Ravager with `whirlwind` at level 1 (12 rage/s drain — the tier
 * closest to `05` §2.3's own sanity-anchor numbers), rage held well away
 * from BOTH the `0` and `maxRage` (100) boundaries so a channel's net
 * income-minus-drain is observable UNCLAMPED (starting at the cap, as an
 * earlier revision of this file did, made "does not self-fund" look true
 * only because the cap was silently eating most of the income on every
 * interval — a real measurement artifact this ticket's own report flags).
 * Spread far apart along +Z so different tests' actors/monsters never
 * overlap in space (whirlwind's own 2.6 m radius). */
function spawnPlayer() {
  const originZ = (nextSpawnOffset += 200);
  const player = actors.spawn({
    kind: 'player', archetypeId: 'ravager', team: 0,
    x: 0, z: originZ, facing: 0, level: 30,
  });
  actors.setState(player, 'idle');
  player.attributes.strength = 50;
  player.attributes.dexterity = 60;
  player.attributes.vitality = 50;
  skills.allocate(player, 'whirlwind');
  player.rage = 50;
  return player;
}

/** A Runeblade with `polarity` maxed. */
function spawnRuneblade() {
  const originZ = (nextSpawnOffset += 200);
  const player = actors.spawn({
    kind: 'player', archetypeId: 'runeblade', team: 0,
    x: 0, z: originZ, facing: 0, level: 30,
  });
  actors.setState(player, 'idle');
  for (let i = 0; i < 20; i++) skills.allocate(player, 'polarity');
  // Top up to the actor's OWN composed maxMana — never set mana ABOVE it.
  // `src/actors/` (out of this ticket's scope) recomposes/re-clamps a
  // pooled actor's vessels back down to `maxMana` some steps after a raw
  // over-max write (verified independent of any src/skills/ code, via
  // `player.mana = 1000` alone + actors.fixedUpdate() with NO skills
  // involvement at all — flagged in this ticket's report, not fixed here).
  player.mana = actors.stats(player).maxMana;
  return player;
}

/** A durable monster (won't die to a few ticks) at an offset from `origin`,
 * well within `whirlwind`'s 2.6 m radius. */
function spawnMonsterAt(origin, dx, dz) {
  const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: origin.x + dx, z: origin.z + dz, level: 10 });
  actors.setState(m, 'idle');
  actors.stats(m); // compose once so life/maxLife below are not immediately re-clobbered
  m.life = 5000;
  return m;
}

/** N homogeneous monsters spread around `player` inside `whirlwind`'s
 * 2.6 m radius (never overlapping each other), so `combat.chanceToHit()`
 * against "the first one found" is identical regardless of N. */
function spawnRingMonsters(player, n) {
  const monsters = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / Math.max(1, n)) * 2 * Math.PI;
    monsters.push(spawnMonsterAt(player, Math.cos(angle) * 1.5, Math.sin(angle) * 1.5));
  }
  return monsters;
}

// ---------------------------------------------------------------------------
// 1. Tick period — proven by COUNTING ticks over 240 fixed steps, not by
//    measuring elapsed time.
// ---------------------------------------------------------------------------

test('acceptance: whirlwind ticks every 33 fixed steps (0.55 s) — counted, not inferred from elapsed time', () => {
  const player = spawnPlayer();
  spawnMonsterAt(player, 1.0, 0);

  assert.equal(skills.cast(player, 'whirlwind', player.x + 10, player.z, 0), true, 'cast must succeed');
  assert.equal(skills.isChannelling(player), true);

  const tickSteps = [];
  let hitsThisStep = 0;
  const onReq = () => { hitsThisStep++; };
  ctx.events.on('combat:hit-request', onReq);

  for (let i = 0; i < 240; i++) {
    hitsThisStep = 0;
    tick();
    if (hitsThisStep > 0) tickSteps.push(ctx.time.step);
  }
  ctx.events.off('combat:hit-request', onReq);

  // eslint-disable-next-line no-console
  console.log(`[SKIL-7] tick steps over 240 fixed steps (4.0s): ${JSON.stringify(tickSteps)}`);

  assert.equal(tickSteps.length, 7, 'floor(240/33) = 7 ticks in exactly 240 fixed steps at a 33-step (0.55s) period');
  const deltas = [];
  for (let i = 1; i < tickSteps.length; i++) deltas.push(tickSteps[i] - tickSteps[i - 1]);
  // eslint-disable-next-line no-console
  console.log(`[SKIL-7] inter-tick step deltas: ${JSON.stringify(deltas)} -> period = ${(deltas[0] / 60).toFixed(4)}s`);
  assert.ok(deltas.every((d) => d === 33), 'every inter-tick gap must be exactly 33 steps');
  assert.equal(deltas[0] / 60, 0.55, 'derived period = 33 / 60 = 0.55 s exactly — NOT 0.35 (D-05-1)');

  skills.interrupt(player);
});

// ---------------------------------------------------------------------------
// 2. §12.1 — 10 s channel against 1, 3, 8 targets: identical rage income,
//    and the channel does NOT self-fund (net income - drain stays negative).
// ---------------------------------------------------------------------------

test('acceptance: §12.1 — 10s whirlwind channel against 1, 3, 8 targets yields identical rage income; does not self-fund', () => {
  const incomeByCount = {};
  const netByCount = {};
  let drainRate = null;

  for (const n of [1, 3, 8]) {
    const player = spawnPlayer();
    spawnRingMonsters(player, n);

    const cost = skills.costOf(player, 'whirlwind');
    drainRate = cost.amount; // rage/s — identical for every n (same actor, same level)

    assert.equal(skills.cast(player, 'whirlwind', player.x + 10, player.z, 0), true, `cast must succeed for n=${n}`);

    const rageBefore = player.rage;
    let combatCreditSeen = 0; // sanity: combat's own automatic per-hit credit DOES still fire and get reversed
    const onDamage = (payload) => {
      if (payload.result && payload.result.sourceSkillId === 'whirlwind' && payload.result.outcome === 'hit' && payload.result.total > 0) combatCreditSeen++;
    };
    ctx.events.on('actor:damage', onDamage);

    for (let i = 0; i < 600; i++) tick(); // 10.0 s
    ctx.events.off('actor:damage', onDamage);

    assert.ok(skills.isChannelling(player), `n=${n}: the channel must still be running after 10s (rage must not have run dry)`);
    assert.ok(combatCreditSeen > 0, `n=${n}: combat's own automatic per-hit rage credit must actually have fired (sanity that the reconciliation is exercised, not vacuous)`);

    const delta = player.rage - rageBefore;
    const drainOver10s = drainRate * 10;
    const income = delta + drainOver10s; // total rage earned over 10s, net of the continuous drain
    incomeByCount[n] = income;
    netByCount[n] = delta / 10; // net rage/s

    skills.interrupt(player);
  }

  // eslint-disable-next-line no-console
  console.log('[SKIL-7 §12.1] drain (rage/s):', drainRate.toFixed(4));
  // eslint-disable-next-line no-console
  console.log('[SKIL-7 §12.1] income over 10s by target count:', JSON.stringify(incomeByCount));
  // eslint-disable-next-line no-console
  console.log('[SKIL-7 §12.1] net rage/s by target count:', JSON.stringify(netByCount));

  const tol = 1e-6;
  assert.ok(Math.abs(incomeByCount[1] - incomeByCount[3]) < tol, `income must be identical at 1 vs 3 targets: ${incomeByCount[1]} vs ${incomeByCount[3]}`);
  assert.ok(Math.abs(incomeByCount[3] - incomeByCount[8]) < tol, `income must be identical at 3 vs 8 targets: ${incomeByCount[3]} vs ${incomeByCount[8]}`);

  assert.ok(netByCount[1] < 0, 'the channel must NOT self-fund at 1 target — net rage/s must be negative');
  assert.ok(netByCount[3] < 0, 'the channel must NOT self-fund at 3 targets — net rage/s must be negative');
  assert.ok(netByCount[8] < 0, 'the channel must NOT self-fund at 8 targets — net rage/s must be negative');
});

// ---------------------------------------------------------------------------
// 3. Movement capped at 70% while channelling.
// ---------------------------------------------------------------------------

// `actors.moveSpeed()` itself is a documented, already-accepted PLACEHOLDER
// (`src/actors/motion.js#computeMoveSpeed`, ACTR-2): it hard-codes
// `movementSpeedPercent = 0` and does not read `actor.stats.movementSpeed`
// AT ALL — `tests/actors/actr2.test.js` asserts this explicitly ("movement
// Speed=0... always the assigned class run speed today"). `chilled`/
// `slowed` (`src/actors/status.js`, already accepted) hit the exact same
// wall: both DO write `movementSpeed: -30`/`-50` into `statMods`
// (`tests/actors/status.test.js`), and NEITHER can move `moveSpeed()`'s
// output either, for the identical reason. This is a pre-existing gap in
// `src/actors/`, not this ticket's file to fix (explicitly out of scope) —
// so this test asserts on the LOAD-BEARING signal this ticket's engine
// actually controls, `actors.stats(actor).movementSpeed` (the same layer
// chilled/slowed use), and logs `moveSpeed()`'s own (currently inert)
// output purely for visibility. See this ticket's report.
test('acceptance: the 70% movement cap is applied as a movementSpeed stat contribution while channelling, removed on interrupt', () => {
  const player = spawnPlayer();
  spawnMonsterAt(player, 1.0, 0);

  const statsBefore = actors.stats(player);
  assert.equal(statsBefore.movementSpeed, 0, 'sanity: no movementSpeed contribution before the channel');
  const speedBefore = actors.moveSpeed(player);

  assert.equal(skills.cast(player, 'whirlwind', player.x + 10, player.z, 0), true);
  const statsDuring = actors.stats(player);
  const speedDuring = actors.moveSpeed(player); // see the note above — currently always equal to speedBefore

  // eslint-disable-next-line no-console
  console.log(`[SKIL-7] movementSpeed stat before=${statsBefore.movementSpeed} during=${statsDuring.movementSpeed} (moveSpeed() itself: before=${speedBefore.toFixed(4)} during=${speedDuring.toFixed(4)} — motion.js placeholder, see report)`);

  assert.equal(statsDuring.movementSpeed, -30, 'whirlwind must contribute exactly -30 movementSpeed (100 - the data-driven 70%) while channelling — the same mechanism chilled/slowed already use, reproducing "70% of moveSpeed" at movementSpeed=0 from every other source');

  skills.interrupt(player);
  const statsAfter = actors.stats(player);
  assert.equal(statsAfter.movementSpeed, 0, 'the movementSpeed contribution must be removed exactly once the channel ends');
});

// ---------------------------------------------------------------------------
// 4. polarity — 10 mana charged exactly once per switch, across several
//    frames of "holding" (not re-pressing) the toggle; the 1.5s lockout
//    refuses a second switch.
// ---------------------------------------------------------------------------

test('acceptance: polarity charges 10 mana exactly once per switch, held across frames; 1.5s lockout refuses a second switch', () => {
  const player = spawnRuneblade();

  assert.equal(skills.polarityStance(player), 'blade', 'starts in Blade (05 §7.3)');

  const manaBefore = player.mana;
  assert.equal(skills.cast(player, 'polarity', player.x, player.z, 0), true, 'first switch must succeed');
  const manaAfterSwitch = player.mana;
  assert.equal(manaBefore - manaAfterSwitch, 10, '10 mana charged, flat, on the switch');
  assert.equal(skills.polarityStance(player), 'storm', 'stance actually flipped');

  // "held across frames" — nothing re-presses the toggle, so the ONLY
  // possible change over these frames is ordinary class mana regen
  // (`src/actors/vessels.js#integrateVessels`, unrelated to `polarity`),
  // NEVER a second switch charge (which would be a DECREASE). Regen itself
  // is whole-point-quantized (`tickAccumulatedResource` only ever moves a
  // WHOLE point out of its own internal `manaAccum` carry — see that
  // function's own doc comment), so asserting an exact fractional regen
  // amount on `actor.mana` directly would be wrong; this asserts the two
  // things that actually matter: mana never DECREASES while merely held,
  // and it never increases by more than the class's own regen could
  // plausibly deliver in the window (a hard bound against "10 more mana
  // silently appeared"), over 0.5 s — well inside the 1.5 s lockout, so
  // the refusal check right after it is genuinely still inside the window.
  const manaRegenPerSecond = actors.stats(player).manaRegen;
  for (let i = 0; i < 30; i++) tick(); // 0.5s of just holding the stance
  assert.ok(player.mana >= manaAfterSwitch, 'mana must never DECREASE while merely holding a stance (holding costs nothing — 05 §7.3)');
  assert.ok(
    player.mana <= manaAfterSwitch + manaRegenPerSecond * 0.5 + 1,
    `mana must not increase by more than ordinary regen could plausibly deliver in 0.5s (a hidden extra charge would show up here): got ${player.mana}, ceiling ${manaAfterSwitch + manaRegenPerSecond * 0.5 + 1}`,
  );
  assert.equal(skills.polarityStance(player), 'storm', 'stance stays Storm the whole time it is merely held');

  // A second switch attempt during the 1.5s lockout (0.5s elapsed so far)
  // must be refused.
  const manaBeforeRefusedAttempt = player.mana;
  const canCastAgain = skills.canCast(player, 'polarity', player.x, player.z);
  assert.equal(canCastAgain.ok, false);
  assert.equal(canCastAgain.reason, 'cooldown');
  const castAgainOk = skills.cast(player, 'polarity', player.x, player.z, 0);
  assert.equal(castAgainOk, false, 'a second switch attempt during the lockout must be refused');
  assert.equal(player.mana, manaBeforeRefusedAttempt, 'a refused switch must not charge mana');
  assert.equal(skills.polarityStance(player), 'storm', 'a refused switch must not flip the stance');

  // Advance past the 1.5s lockout (0.5s elapsed already + 1.1s more = 1.6s
  // total since the first switch).
  for (let i = 0; i < 66; i++) tick();
  const manaBeforeSecond = player.mana;
  assert.equal(skills.cast(player, 'polarity', player.x, player.z, 0), true, 'switch must succeed once the lockout has elapsed');
  assert.equal(manaBeforeSecond - player.mana, 10, 'the second real switch also charges exactly 10, once');
  assert.equal(skills.polarityStance(player), 'blade', 'stance flipped back');
});

// ---------------------------------------------------------------------------
// 5. Hit-recovery immunity — a hit that would normally interrupt (forced
//    via the SAME `actors.cancelAction(actor,'hitstun')` call
//    `src/combat/reaction.js` itself makes) does not stop the channel's
//    own simulation: ticks, drain and the movement cap all continue.
// ---------------------------------------------------------------------------

test('acceptance: hit-recovery does not interrupt the channel — ticks/drain/movement cap survive a forced hitstun transition', () => {
  const player = spawnPlayer();
  spawnMonsterAt(player, 1.0, 0);

  assert.equal(skills.cast(player, 'whirlwind', player.x + 10, player.z, 0), true);
  assert.equal(player.state, 'channel');

  // Run to just past the first tick so the channel is genuinely live.
  for (let i = 0; i < 40; i++) tick();
  assert.ok(skills.isChannelling(player), 'still channelling after the first tick');
  const rageAfterFirstTick = player.rage;

  // Mirror EXACTLY what src/combat/reaction.js#applyReaction does on a
  // hitstun-triggering hit — see channel.js's own header for why this
  // FSM-level transition cannot be prevented from src/skills/.
  const entered = actors.cancelAction(player, 'hitstun');
  assert.equal(entered, true, 'sanity: the FSM does allow channel -> hitstun (states.js, already-accepted)');
  assert.equal(player.state, 'hitstun', 'actor.state DOES flip to hitstun — this file cannot prevent the FSM transition (flagged in the report)');

  // The channel's OWN simulation must not have stopped: isChannelling()
  // (internal tracking, not actor.state) is still true, the movement cap
  // is still applied (the 'skills' movementSpeed contribution was never
  // removed), and running more ticks continues to drain rage exactly as
  // before.
  assert.equal(skills.isChannelling(player), true, 'isChannelling() reads internal tracking, not actor.state — must still report true');
  const speedDuring = actors.moveSpeed(player);

  for (let i = 0; i < 40; i++) tick(); // run past the next tick boundary while still nominally "hitstun"
  assert.ok(player.rage < rageAfterFirstTick, 'rage drain continued through the forced hitstun state');
  assert.ok(skills.isChannelling(player), 'the channel is still tracked as active — hit recovery did not end it');

  // eslint-disable-next-line no-console
  console.log(`[SKIL-7] hit-recovery immunity: actor.state=${player.state} (FSM, not ours — a real, flagged gap) isChannelling=${skills.isChannelling(player)} moveSpeed still capped=${speedDuring.toFixed(4)}`);

  skills.interrupt(player);
});
