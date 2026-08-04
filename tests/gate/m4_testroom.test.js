// tests/gate/m4_testroom.test.js
//
// M4 gate item ⑧ — "Each class clears the test room with its level-1 skills,
// as three real scripted sessions — one per class, through `boot()`" — and
// item ⑨, "Resonance visibly fills and is spent".
//
// ---------------------------------------------------------------------------
// The test room is ASSIGNED here, because no document defines it
// ---------------------------------------------------------------------------
// "The test room" appears in `docs/BACKLOG.md`'s M4 gate row, in `12-testing.md`
// §11's M4 row and in the M4 orchestrator prompt — and nowhere with a single
// dimension, monster count or level. Every number below is therefore this
// file's own choice, listed so a reader can disagree with the room rather than
// with the verdict:
//
//   zone            `last_bastion` — the one shipped zone with no packs of its
//                   own, so nothing spawns except what this file places
//   monsters        5 x `bone_ranker`, mlvl 3, rank `normal`, no affixes
//   layout          a ring of radius 2.0 m centred on the player
//   player          clvl 10, one weapon in `mainHand`, 5 points in the class's
//                   first offensive skill, attributes raised to 60/60/40
//   budget          3600 steps = 60.0 s of simulation per class
//
// Two of those need their reasoning stated, because they are the difference
// between a real check and a rigged one:
//
// **The weapon.** A bare-handed character composes `minDamage`/`maxDamage` = 0
// (measured: unarmed 0/0, and `03` §11.1's reference builds all carry a
// weapon). The room is still cleared unarmed — 53.1 s against 20.5 s armed,
// both measured — so the weapon is not what makes this pass; it is what makes
// the session resemble the game. It is rolled from a fixed seed and equipped
// through the real `items.equip`, which refuses on unmet requirements, which
// is why the attributes are raised first.
//
// **No life refill.** An earlier draft of this probe pinned the player's life
// at max each step to isolate "can the class kill" from "can the class
// survive". That is a legitimate diagnostic and an illegitimate gate: item ⑧'s
// own wording is "spawn, allocate, cast, kill, survive". The sessions below do
// not touch `life` after the fight starts.
//
// ---------------------------------------------------------------------------
// Why 3600 steps, and the mistake this file exists to not repeat
// ---------------------------------------------------------------------------
// Two separate sessions have now reported "2 of 5" for the Ravager and drawn
// conclusions from it — one ruled the gate item closed anyway, one recorded it
// as a defect in melee approach. Both were measuring their own step budget:
// at 1800 steps the Ravager has killed 2, at 3186 it has killed all five. The
// budget here is 3600 and the assertion prints the step count it actually
// used, so a future reader can tell "cleared" from "cleared with 3 steps to
// spare".

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { Rng } from '../../src/core/rng.js';

const STEP_BUDGET = 3600; // 60.0 s at 60 Hz
const RING_RADIUS_M = 2.0;
const MONSTER_COUNT = 5;
const MONSTER_MLVL = 3;
const SKILL_POINTS = 5;

/** `05`'s own first offensive skill per class, read off
 * `src/skills/data/skills.js`'s declaration order. */
const CLASS_OPENER = Object.freeze({
  ravager: 'cleaving_strike',
  emberwright: 'ember_bolt',
  runeblade: 'rune_strike',
});

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

/**
 * Boots the real engine, builds the room, and returns the live handles.
 * Everything here goes through a contracted call — `world.enterZone`,
 * `items.equip`, `skills.allocate`, `player.setHotbar`, `ai.spawnOne`,
 * `actors.teleport` — so the session exercises the same path the game does.
 */
async function openRoom(classId, extraSkills = []) {
  const { engine, ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const world = ctx.peek('world');
  const actors = ctx.peek('actors');
  const player = ctx.peek('player');
  const skills = ctx.peek('skills');
  const items = ctx.peek('items');
  const ai = ctx.peek('ai');

  world.setWorldSeed(0x5eed1234);
  await world.enterZone('last_bastion', 'town_start', { runIndex: 0 });

  const me = actors.all.find((a) => a.kind === 'player');
  assert.ok(me, 'boot() must place a player actor');
  me.classId = classId;
  me.level = 10;
  // Raised so `items.equip`'s requirement check can pass — it refuses with
  // `{ok:false, reason:'dexterity'}` otherwise, measured.
  me.attributes.strength = 60;
  me.attributes.dexterity = 60;
  me.attributes.vitality = 40;
  me.statsDirty = true;

  let weapon = null;
  for (let i = 0; i < 40 && !weapon; i++) {
    const inst = items.rollItem(9100 + i, 12, 8, 'normal', 'instruction', 0, null, new Rng(100 + i));
    if (!inst || !(items.slotsFor(inst) || []).includes('mainHand')) continue;
    const r = items.equip(me, inst, 'mainHand');
    if (r && r.ok) weapon = inst.baseId;
  }
  me.statsDirty = true;

  const opener = CLASS_OPENER[classId];
  for (let i = 0; i < SKILL_POINTS; i++) skills.allocate(me, opener);
  for (const sid of extraSkills) for (let i = 0; i < SKILL_POINTS; i++) skills.allocate(me, sid);
  player.setHotbar(0, opener);
  extraSkills.forEach((sid, i) => player.setHotbar(i + 1, sid));
  player.setControlEnabled(true);

  actors.teleport(me, 0, 0);
  const monsters = [];
  for (let i = 0; i < MONSTER_COUNT; i++) {
    const a = (2 * Math.PI * i) / MONSTER_COUNT;
    const m = ai.spawnOne('bone_ranker', Math.cos(a) * RING_RADIUS_M, Math.sin(a) * RING_RADIUS_M, MONSTER_MLVL, 'normal', []);
    if (m) monsters.push(m);
  }
  assert.equal(monsters.length, MONSTER_COUNT, 'every monster must be placed through the real ai.spawnOne');

  return { engine, ctx, world, actors, player, skills, items, ai, me, monsters, weapon, opener };
}

const aliveCount = (monsters) => monsters.filter((m) => !m.dead && m.life > 0).length;

test('M4 gate ⑧: the Ravager clears the test room, through boot(), and survives', async () => {
  const room = await openRoom('ravager');
  const { engine, me, monsters } = room;
  let steps = 0;
  let minResource = Infinity;
  for (; steps < STEP_BUDGET && aliveCount(monsters) > 0 && !me.dead; steps++) {
    if (steps % 10 === 0) {
      const t = monsters.find((m) => !m.dead && m.life > 0);
      if (t) room.player.castOrder(0, t.x, t.z, t.id);
    }
    engine.frame(1 / 60);
    if (me.rage < minResource) minResource = me.rage;
  }
  assert.equal(aliveCount(monsters), 0, `Ravager must clear the room; ${aliveCount(monsters)} left after ${steps} steps`);
  assert.equal(me.dead, false, 'and must be alive at the end — item ⑧ is "kill AND survive"');
  assert.ok(minResource >= 0, `05 §13.2 B8: rage must never go negative (min ${minResource})`);
  console.log(`  ⑧ ravager: cleared ${MONSTER_COUNT}/${MONSTER_COUNT} in ${steps} steps (${(steps / 60).toFixed(1)} s of ${(STEP_BUDGET / 60).toFixed(0)} s), weapon ${room.weapon}, life ${Math.round(me.life)}, rage floor ${minResource.toFixed(1)}`);
});

test('M4 gate ⑧: the Emberwright clears the test room, through boot(), and survives', async () => {
  const room = await openRoom('emberwright');
  const { engine, me, monsters } = room;
  let steps = 0;
  let minResource = Infinity;
  for (; steps < STEP_BUDGET && aliveCount(monsters) > 0 && !me.dead; steps++) {
    if (steps % 10 === 0) {
      const t = monsters.find((m) => !m.dead && m.life > 0);
      if (t) room.player.castOrder(0, t.x, t.z, t.id);
    }
    engine.frame(1 / 60);
    if (me.mana < minResource) minResource = me.mana;
  }
  assert.equal(aliveCount(monsters), 0, `Emberwright must clear the room; ${aliveCount(monsters)} left after ${steps} steps`);
  assert.equal(me.dead, false, 'and must be alive at the end');
  assert.ok(minResource >= 0, `05 §13.2 B8: mana must never go negative (min ${minResource})`);
  console.log(`  ⑧ emberwright: cleared ${MONSTER_COUNT}/${MONSTER_COUNT} in ${steps} steps (${(steps / 60).toFixed(1)} s), weapon ${room.weapon}, life ${Math.round(me.life)}, mana floor ${minResource.toFixed(1)}`);
});

test('M4 gate ⑧ + ⑨: the Runeblade clears the room, and Resonance visibly fills and is spent', async () => {
  // Item ⑨ wants the Runeblade session to SHOW the bar reaching cap and
  // `blade_seal` emptying it, so `blade_seal` is allocated and bound to slot 1
  // and fired whenever Resonance is at its observed peak.
  const room = await openRoom('runeblade', ['blade_seal']);
  const { engine, actors, me, monsters } = room;
  const cap = actors.stats(me).maxResonance;
  let steps = 0;
  let peak = 0;
  let minResource = Infinity;
  let sealCasts = 0;
  let dropAtCap = 0;
  let inCombatDrop = 0;
  let prev = me.resonance;
  let sealing = false;
  for (; steps < STEP_BUDGET && aliveCount(monsters) > 0 && !me.dead; steps++) {
    // Two phases. Until the bar is full, hit things — Resonance is +1 per
    // landed hit (`RESONANCE_PER_LANDED_HIT`) and the base cap is 3, so it
    // fills in three landed hits. Once it is at cap, stop attacking and order
    // `blade_seal` EVERY step until it is accepted: `canCast` answers
    // `{ok:false, reason:'busy'}` throughout `rune_strike`'s own recover
    // phase, so an order issued on a fixed cadence is simply dropped — the
    // first draft of this test ordered the seal twice, had both refused, and
    // then read the post-combat decay as if it were the sink.
    if (!sealing && me.resonance >= cap) sealing = true;
    if (sealing) {
      room.player.castOrder(1, me.x, me.z, 0);
      sealCasts++;
    } else if (steps % 10 === 0) {
      const t = monsters.find((m) => !m.dead && m.life > 0);
      if (t) room.player.castOrder(0, t.x, t.z, t.id);
    }
    engine.frame(1 / 60);
    if (me.resonance > peak) peak = me.resonance;
    if (me.resonance < minResource) minResource = me.resonance;
    const drop = prev - me.resonance;
    if (drop > 0 && sealing) {
      inCombatDrop += drop;
      if (prev >= cap) dropAtCap = Math.max(dropAtCap, drop);
    }
    prev = me.resonance;
    // Back to killing once the bar has been emptied.
    if (sealing && me.resonance <= 0) sealing = false;
  }
  assert.equal(aliveCount(monsters), 0, `Runeblade must clear the room; ${aliveCount(monsters)} left after ${steps} steps`);
  assert.equal(me.dead, false, 'and must be alive at the end');
  assert.ok(minResource >= 0, `05 §13.2 B8: resonance must never go negative (min ${minResource})`);
  // Item ⑨'s two halves, asserted separately so a failure says which one.
  // "Reaching cap" is asserted against the composed `maxResonance` rather
  // than against a literal: `05`'s base is 3 and `mana_weave`/
  // `resonance_circuit` can raise it, so a hardcoded 3 would be a moment.
  assert.equal(peak, cap, `item ⑨ (fills): Resonance must reach its cap (peak ${peak}, cap ${cap})`);
  assert.ok(dropAtCap > 0,
    `item ⑨ (is spent): blade_seal must empty a FULL bar — largest drop from cap was ${dropAtCap}. This must be the seal, not the out-of-combat decay 03 §2.4 applies after the fight`);
  assert.equal(dropAtCap, cap, `05 §8.5 / D-05-2: blade_seal spends 'all' — the whole ${cap} in one step, got ${dropAtCap}`);
  console.log(`  ⑧ runeblade: cleared ${MONSTER_COUNT}/${MONSTER_COUNT} in ${steps} steps (${(steps / 60).toFixed(1)} s), weapon ${room.weapon}, life ${Math.round(me.life)}`);
  console.log(`  ⑨ resonance: cap ${cap}, peak ${peak.toFixed(1)}, single-step drop from cap ${dropAtCap.toFixed(1)} (05 §8.5 'all'), total spent in combat ${inCombatDrop.toFixed(1)}, floor ${minResource.toFixed(1)}, blade_seal ordered ${sealCasts}x`);
});
