// tests/player/hudstate.test.js
//
// PLYR-10 acceptance tests for `PlayerSystem#hudState` (src/player/index.js)
// — `02-api-contracts.md:1189`/`:1199-1213`, the HUD's only path to a
// persistent value (`09-ui.md` §D-A). `node:test` + `node:assert/strict`
// only (12-testing.md P6).
//
// Scope, matching the file's own "PLYR-10 addendum": every contract field is
// present with the contract's type and default; `life`/`mana`/`maxLife`/
// `maxMana`/`secondary`/`maxSecondary`/`secondaryKind` track the real actor
// record and the composed `StatBlock` (O-57 closed by ACTR-15,
// `docs/PROGRESS.md` D-29); every other field — including `secondaryDecay`,
// still blocked (see the file header) — is checked against TODAY's
// documented default, never asserted as if that default were a permanent
// fact (O-27). `src/actors/stats.js` IS imported below (for `CLASS_TABLE`/
// verification only, never by `src/player/index.js` itself — hard rule 2
// applies to production code, not to a test independently checking its
// output) to prove `hudState()`'s per-class derivation is correct without
// duplicating that table's numbers by hand.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { PlayerSystem } from '../../src/player/index.js';
import { CLASS_TABLE } from '../../src/actors/stats.js';

/** Matches tests/player/plyr1.test.js's own stub canvas. */
function makeCanvas(width = 1280, height = 720) {
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    addEventListener() {},
    removeEventListener() {},
  };
}

async function bootGame(opts = {}) {
  return boot({ canvas: makeCanvas(), deterministic: true, global: {}, ...opts });
}

// `02-api-contracts.md:1199-1213`'s `HudState` literal, transcribed field-by-
// field with its type, so the field-list test below diffs against the spec
// itself rather than against `src/player/index.js`'s own idea of the shape.
const EXPECTED_FIELD_TYPES = {
  life: 'number', maxLife: 'number', mana: 'number', maxMana: 'number',
  secondary: 'number', maxSecondary: 'number', secondaryKind: 'string',
  secondaryDecay: 'number',
  level: 'number', xp: 'number', xpFloor: 'number', xpCeiling: 'number', xpTotal: 'number',
  statPoints: 'number', skillPoints: 'number', gold: 'number',
  cooldowns: 'array', hotbar: 'array',
  belt: 'array', targetId: 'number', difficulty: 'string',
  zoneId: 'string', questStep: 'number',
  name: 'string', classId: 'string',
  inCombat: 'boolean',
};
const EXPECTED_FIELD_COUNT = 26; // 02-api-contracts.md:1199-1213, counted by hand

// ---------------------------------------------------------------------------
// Shape: every contract field present, correctly typed, nothing extra
// ---------------------------------------------------------------------------

test('hudState(): field list matches 02-api-contracts.md:1199-1213 exactly — every field, right type, nothing extra', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');

  const hud = player.hudState();
  const keys = Object.keys(EXPECTED_FIELD_TYPES);
  assert.equal(keys.length, EXPECTED_FIELD_COUNT, 'the transcribed expectation itself must have 26 fields');

  const actualKeys = Object.keys(hud).sort();
  assert.deepEqual(actualKeys, keys.slice().sort(), 'hudState() must return exactly the HudState literal\'s field set — no more, no fewer');

  for (const [field, expectedType] of Object.entries(EXPECTED_FIELD_TYPES)) {
    if (expectedType === 'array') {
      assert.ok(Array.isArray(hud[field]), `${field} must be an array`);
    } else {
      assert.equal(typeof hud[field], expectedType, `${field} must be a ${expectedType}, got ${typeof hud[field]}`);
    }
  }

  assert.equal(hud.cooldowns.length, 4, 'cooldowns is a fixed 4-length array');
  assert.equal(hud.hotbar.length, 4, 'hotbar is a fixed 4-length array');
  assert.equal(hud.belt.length, 4, 'belt is a fixed 4-length array');
});

test('hudState(): no-argument form returns a valid, fully-shaped HudState (does not throw, not undefined)', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');

  const hud = player.hudState();
  assert.ok(hud, 'hudState() with no argument must return an object');
  assert.equal(typeof hud.life, 'number');
});

test('hudState(): with no actor yet (bare, un-init()ed PlayerSystem), returns the shape with life/mana at 0 — never throws', () => {
  const player = new PlayerSystem();
  const hud = player.hudState();
  assert.equal(hud.life, 0);
  assert.equal(hud.mana, 0);
  assert.equal(Object.keys(hud).length, EXPECTED_FIELD_COUNT);
});

// ---------------------------------------------------------------------------
// Alloc contract shape: writes into `out`, returns it, mutates arrays in
// place (never replaces them) — the correctness half; tests/player/
// hudstate.perf.test.js measures the actual byte budget.
// ---------------------------------------------------------------------------

function makeCallerHudState() {
  return {
    life: -1, maxLife: -1, mana: -1, maxMana: -1,
    secondary: -1, maxSecondary: -1, secondaryKind: 'stale',
    secondaryDecay: -1,
    level: -1, xp: -1, xpFloor: -1, xpCeiling: -1, xpTotal: -1,
    statPoints: -1, skillPoints: -1, gold: -1,
    cooldowns: [9, 9, 9, 9], hotbar: ['x', 'x', 'x', 'x'],
    belt: [9, 9, 9, 9], targetId: -1, difficulty: 'stale',
    zoneId: 'stale', questStep: -1,
    name: 'stale', classId: 'stale',
    inCombat: true,
  };
}

test('hudState(out): returns the exact same object it was given (the out convention)', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');

  const out = makeCallerHudState();
  const result = player.hudState(out);
  assert.equal(result, out, 'hudState(out) must return the identical `out` reference');
});

test('hudState(out): overwrites every stale field on a caller-supplied object', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');

  const out = makeCallerHudState();
  player.hudState(out);

  assert.notEqual(out.secondaryKind, 'stale');
  assert.notEqual(out.difficulty, 'stale');
  assert.notEqual(out.zoneId, 'stale');
  assert.notEqual(out.name, 'stale');
  assert.notEqual(out.classId, 'stale');
  assert.equal(out.inCombat, false);
  assert.equal(out.level, 1);
  assert.equal(out.xp, 0);
  assert.equal(out.gold, 0);
});

test('hudState(out): cooldowns/hotbar/belt are written in place — same array identity, elements reset', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');

  const out = makeCallerHudState();
  const cooldownsRef = out.cooldowns;
  const hotbarRef = out.hotbar;
  const beltRef = out.belt;

  player.hudState(out);

  assert.equal(out.cooldowns, cooldownsRef, 'cooldowns array must be mutated in place, never replaced');
  assert.equal(out.hotbar, hotbarRef, 'hotbar array must be mutated in place, never replaced');
  assert.equal(out.belt, beltRef, 'belt array must be mutated in place, never replaced');

  assert.deepEqual(out.cooldowns, [0, 0, 0, 0]);
  assert.deepEqual(out.hotbar, [null, null, null, null]);
  assert.deepEqual(out.belt, [0, 0, 0, 0]);
});

// ---------------------------------------------------------------------------
// life/mana — real today, tracking the live Actor record
// (01-data-model.md §2, src/actors/vessels.js: plain fields, no accessor
// needed).
// ---------------------------------------------------------------------------

test('hudState(): life/mana equal the live actor\'s life/mana at call time', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;
  assert.ok(actor, 'a placeholder player actor must exist after boot()');

  actor.life = 317;
  actor.mana = 42;

  const hud = player.hudState();
  assert.equal(hud.life, 317);
  assert.equal(hud.mana, 42);
});

test('hudState(): life/mana are read fresh every call, not snapshotted once', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;

  actor.life = 100;
  assert.equal(player.hudState().life, 100);

  actor.life = 55;
  assert.equal(player.hudState().life, 55, 'a later call must reflect the actor\'s current life, not a stale reading');
});

// ---------------------------------------------------------------------------
// maxLife/maxMana — O-57 closed (ACTR-15): now live off the composed
// StatBlock (ctx.get('actors').stats(actor)), never a second formula
// re-derived by hand here.
// ---------------------------------------------------------------------------

test('hudState(): maxLife/maxMana equal actors.stats(actor)\'s composed StatBlock', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const actor = player.actor;
  actor.life = 250; // proves this isn't just "actor never spawned" — life is independently live too

  const s = actors.stats(actor);
  const hud = player.hudState();
  assert.equal(hud.maxLife, s.maxLife);
  assert.equal(hud.maxMana, s.maxMana);
  assert.ok(hud.maxLife > 0, 'the ravager placeholder\'s CLASS_TABLE row gives it a nonzero maxLife');
});

test('hudState(): maxLife updates when the StatBlock recomposes, not snapshotted once at spawn', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const actor = player.actor;

  const before = player.hudState().maxLife;
  actors.setSourceLayer(actor, 'equipment', { maxLife: 500 });
  const after = player.hudState().maxLife;

  assert.equal(after, before + 500, 'a flat +500 maxLife equipment layer must show up on the next hudState() call');
});

// ---------------------------------------------------------------------------
// secondary/maxSecondary/secondaryKind — derived per-class from the
// StatBlock's maxRage/maxResonance, never a second copy of stats.js's
// CLASS_TABLE (rule 9). actor.rage/actor.resonance are plain Actor-record
// fields (ACTR-8), read live like life/mana.
// ---------------------------------------------------------------------------

test('hudState(): the ravager placeholder actor gets secondaryKind "rage", secondary tracking actor.rage live', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  const actor = player.actor;
  assert.equal(actor.classId, 'ravager', 'PLYR-10\'s own placeholder spawns a ravager — see src/player/index.js PLACEHOLDER_ARCHETYPE_ID');
  assert.ok(CLASS_TABLE.ravager.baseRage > 0 && CLASS_TABLE.ravager.baseResonance === 0, 'sanity: ravager only has a rage pool');

  actor.rage = 37;
  let hud = player.hudState();
  assert.equal(hud.secondaryKind, 'rage');
  assert.equal(hud.secondary, 37);
  assert.equal(hud.maxSecondary, actors.stats(actor).maxRage);

  actor.rage = 81; // read fresh every call, not snapshotted
  hud = player.hudState();
  assert.equal(hud.secondary, 81);
});

test('hudState(): a runeblade actor gets secondaryKind "resonance", secondary tracking actor.resonance live', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  assert.ok(CLASS_TABLE.runeblade.baseResonance > 0 && CLASS_TABLE.runeblade.baseRage === 0, 'sanity: runeblade only has a resonance pool');

  const runeblade = actors.spawn({ kind: 'player', team: 0, archetypeId: 'runeblade', x: 5, z: 5, facing: 0 });
  const savedActor = player.actor;
  player._actor = runeblade; // this test's own instance, swapped back below

  runeblade.resonance = 2;
  const hud = player.hudState();
  assert.equal(hud.secondaryKind, 'resonance');
  assert.equal(hud.secondary, 2);
  assert.equal(hud.maxSecondary, actors.stats(runeblade).maxResonance);
  assert.ok(hud.maxSecondary > 0);

  player._actor = savedActor;
});

test('hudState(): an emberwright actor (no secondary resource) gets secondaryKind "mana", secondary/maxSecondary at 0', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');
  assert.equal(CLASS_TABLE.emberwright.baseRage, 0);
  assert.equal(CLASS_TABLE.emberwright.baseResonance, 0);

  const emberwright = actors.spawn({ kind: 'player', team: 0, archetypeId: 'emberwright', x: 5, z: 5, facing: 0 });
  const savedActor = player.actor;
  player._actor = emberwright;

  const hud = player.hudState();
  assert.equal(hud.secondaryKind, 'mana', '09-ui.md §4.1.2: the Emberwright\'s resource orb reads mana/maxMana directly, not secondary');
  assert.equal(hud.secondary, 0);
  assert.equal(hud.maxSecondary, 0);

  player._actor = savedActor;
});

// ---------------------------------------------------------------------------
// secondaryDecay — still at its contract default. Not O-57 (closed): it
// needs `inCombat` (itself left at the literal's default per this ticket's
// own brief) plus decay-rate data that is private to src/actors/vessels.js.
// See the file header's "PLYR-10 addendum" for the full reasoning; this test
// documents TODAY's value, not a permanent fact (O-27).
// ---------------------------------------------------------------------------

test('hudState(): secondaryDecay holds the HudState literal\'s own default today (still blocked, not on O-57)', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actor = player.actor;
  actor.rage = 90; // proves this isn't "no secondary resource" — secondary IS live, decay still defaults

  const hud = player.hudState();
  assert.equal(hud.secondaryDecay, 0);
});

test('hudState(): fields owned by systems landing M4/M6 hold the HudState literal\'s own defaults today', async () => {
  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const hud = player.hudState();

  assert.equal(hud.xp, 0);
  assert.equal(hud.xpFloor, 0);
  assert.equal(hud.xpCeiling, 50);
  assert.equal(hud.xpTotal, 0);
  assert.equal(hud.statPoints, 0);
  assert.equal(hud.skillPoints, 0);
  assert.equal(hud.gold, 0);
  assert.equal(hud.questStep, 0);
  assert.deepEqual(hud.cooldowns, [0, 0, 0, 0]);
  assert.deepEqual(hud.hotbar, [null, null, null, null]);
  assert.deepEqual(hud.belt, [0, 0, 0, 0]);
});
