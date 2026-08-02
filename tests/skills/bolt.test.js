// tests/skills/bolt.test.js
//
// SKIL-4 acceptance tests for `src/skills/impl/bolt.js` (`ember_bolt`) —
// the cast -> spawn hand-off, and the pierce demonstration (criterion #2:
// "pierce from slvl 10 hits each body exactly once").
//
// Built against a REAL `boot()` (`src/main.js`), same "one boot() for the
// whole file" precedent `tests/skills/cleaving_strike.test.js`/
// `tests/skills/rune_strike.test.js` already establish.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';

const H = 1 / 60;

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
const actors = ctx.get('actors');
const skills = ctx.get('skills');

function tick() {
  ctx.time.step++;
  actors.fixedUpdate(H, ctx);
  skills.fixedUpdate(H, ctx);
}

function runActionToCompletion(actor, maxTicks = 600) {
  let n = 0;
  while (actor.actionId !== null && n < maxTicks) {
    tick();
    n++;
  }
  return n;
}

/** Runs fixed steps until every live projectile has expired (or `maxTicks`
 * is exhausted) — a real, multi-tick flight, never a synchronous shortcut. */
function runUntilNoProjectiles(maxTicks = 400) {
  let n = 0;
  while (skills.projectileCount > 0 && n < maxTicks) {
    tick();
    n++;
  }
  return n;
}

let nextSpawnOffset = 2000; // clear of the other two skill test files' own spawn bands

function spawnEmberwright(level) {
  const originZ = (nextSpawnOffset += 200);
  const player = actors.spawn({
    kind: 'player', archetypeId: 'emberwright', team: 0,
    x: 0, z: originZ, facing: 0, level: 30,
  });
  actors.setState(player, 'idle');
  player.attributes.energy = 60;
  for (let i = 0; i < level; i++) skills.allocate(player, 'ember_bolt');
  actors.stats(player);
  player.mana = 1000;
  return player;
}

function spawnMonsterAt(origin, dx, dz) {
  const m = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: origin.x + dx, z: origin.z + dz, level: 1 });
  actors.setState(m, 'idle');
  actors.stats(m);
  m.life = 100000;
  return m;
}

// ---------------------------------------------------------------------------
// Basic cast acceptance — a bolt is spawned, flies, and lands one hit on a
// single body in its way.
// ---------------------------------------------------------------------------

test('acceptance: ember_bolt cast spawns exactly one projectile, which lands exactly one hit on a body in its path', () => {
  const player = spawnEmberwright(5); // below pierce threshold — a single-target bolt
  const monster = spawnMonsterAt(player, 5.0, 0);

  let hitRequests = 0;
  const onReq = () => { hitRequests++; };
  ctx.events.on('combat:hit-request', onReq);

  const countBefore = skills.projectileCount;
  const ok = skills.cast(player, 'ember_bolt', player.x + 50, player.z, 0);
  assert.equal(ok, true, 'cast() must succeed against a mana-affording, idle, fully-allocated actor');

  // No projectile exists yet — it spawns at the entry to `active` (0.65 of
  // the cast interval in), not at the moment cast() itself returns.
  assert.equal(skills.projectileCount, countBefore, 'no projectile exists until the cast enters its active phase');

  // The target is close (5 m) relative to the bolt's speed (26 m/s), so it
  // can be hit and expire again well before the CAST action itself finishes
  // its own recovery phase — `runActionToCompletion` therefore is not the
  // right moment to assert "exactly one projectile is currently alive"
  // (that window can already have closed by the time it returns). What
  // matters, and is asserted below instead: exactly one hit landed, and no
  // projectile is left over once everything has settled.
  runActionToCompletion(player);
  runUntilNoProjectiles();
  ctx.events.off('combat:hit-request', onReq);

  assert.equal(hitRequests, 1, 'a single non-piercing bolt through one body must land exactly one hit');
  assert.equal(skills.projectileCount, 0, 'the projectile must be gone once its flight resolves');
});

// ---------------------------------------------------------------------------
// Criterion #2 — pierce from slvl 10 hits each body in its path exactly
// once, never zero, never twice.
// ---------------------------------------------------------------------------

test('acceptance: pierce (slvl >= 10) hits each of 3 lined-up bodies exactly once', () => {
  const player = spawnEmberwright(20); // effective level 20 >= pierce.fromLevel (10)

  // Three bodies lined up along +X from the player, well separated (3 m
  // apart — comfortably more than one fixed step's travel distance at
  // 26 m/s / 60 Hz = 0.433 m, so each is resolved in its own step, and well
  // clear of each other's own 0.36 m collision radius).
  const m1 = spawnMonsterAt(player, 3, 0);
  const m2 = spawnMonsterAt(player, 6, 0);
  const m3 = spawnMonsterAt(player, 9, 0);

  const hitsPerTarget = new Map();
  const onReq = ({ target }) => { hitsPerTarget.set(target.id, (hitsPerTarget.get(target.id) || 0) + 1); };
  ctx.events.on('combat:hit-request', onReq);

  const ok = skills.cast(player, 'ember_bolt', player.x + 50, player.z, 0);
  assert.equal(ok, true);

  runActionToCompletion(player);
  assert.equal(skills.projectileCount, 1, 'exactly one projectile must have spawned');

  const flightTicks = runUntilNoProjectiles();
  assert.ok(flightTicks > 0 && flightTicks < 400, 'the bolt must finish its flight (hit a wall/expire) within the tick budget');

  ctx.events.off('combat:hit-request', onReq);

  console.log(`[SKIL-4 pierce] hits per body: m1=${hitsPerTarget.get(m1.id) || 0}, m2=${hitsPerTarget.get(m2.id) || 0}, m3=${hitsPerTarget.get(m3.id) || 0} (flight took ${flightTicks} ticks)`);

  assert.equal(hitsPerTarget.get(m1.id), 1, 'body 1 must be hit exactly once');
  assert.equal(hitsPerTarget.get(m2.id), 1, 'body 2 must be hit exactly once');
  assert.equal(hitsPerTarget.get(m3.id), 1, 'body 3 must be hit exactly once');
  assert.equal(hitsPerTarget.size, 3, 'no OTHER actor must have been hit at all');
});

// ---------------------------------------------------------------------------
// Below the pierce threshold, the bolt stops at the first body — the
// contrasting case that proves the pierce test above isn't a vacuous "every
// bolt hits everything" artifact.
// ---------------------------------------------------------------------------

test('below slvl 10, the bolt stops at the FIRST body — never reaches the second', () => {
  const player = spawnEmberwright(5); // effective level 5 < pierce.fromLevel (10)

  const m1 = spawnMonsterAt(player, 3, 0);
  const m2 = spawnMonsterAt(player, 6, 0);

  const hitsPerTarget = new Map();
  const onReq = ({ target }) => { hitsPerTarget.set(target.id, (hitsPerTarget.get(target.id) || 0) + 1); };
  ctx.events.on('combat:hit-request', onReq);

  assert.equal(skills.cast(player, 'ember_bolt', player.x + 50, player.z, 0), true);
  runActionToCompletion(player);
  runUntilNoProjectiles();

  ctx.events.off('combat:hit-request', onReq);

  assert.equal(hitsPerTarget.get(m1.id), 1, 'the first body must still be hit once');
  assert.equal(hitsPerTarget.has(m2.id), false, 'a non-piercing bolt must never reach the second body');
});
