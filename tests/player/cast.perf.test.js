// tests/player/cast.perf.test.js
//
// PLYR-3's own `Alloc: no` gates: `hudState()`'s hotbar/cooldowns loop (now
// real, see cast.test.js) must not have turned an already allocation-free
// method into one that allocates, and `hoverTarget`'s new per-frame
// `physics.overlapCircle` pick must itself be allocation-free. O-43/O-23
// methodology, verbatim (see tests/player/hudstate.perf.test.js — this file
// matches its pattern exactly, just with a REAL hotbar slot assigned so the
// timed path is the one this ticket actually changed, not the empty-slot
// branch already covered there). Named `.perf.test.js` per D-11.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

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

test('12.A0x: hudState(out) with a REAL hotbar slot assigned still allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const skills = ctx.get('skills');
  const actor = player.actor;

  skills.allocate(actor, 'cleaving_strike');
  player.setHotbar(0, 'cleaving_strike');

  const out = {
    life: 0, maxLife: 0, mana: 0, maxMana: 0,
    secondary: 0, maxSecondary: 0, secondaryKind: 'rage',
    secondaryDecay: 0,
    level: 1, xp: 0, xpFloor: 0, xpCeiling: 50, xpTotal: 0,
    statPoints: 0, skillPoints: 0, gold: 0,
    cooldowns: [0, 0, 0, 0], hotbar: [null, null, null, null],
    belt: [0, 0, 0, 0], targetId: 0, difficulty: 'instruction',
    zoneId: 'last_bastion', questStep: 0,
    name: '', classId: 'ravager',
    inCombat: false,
  };

  const runOneCall = () => player.hudState(out);

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `hudState(out) w/ real hotbar allocation (O-43): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `hudState(out) must allocate < 1 byte/call marginally between N=1e6 and N=4e6 with a real hotbar slot; ` +
      `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
  assert.deepEqual(out.hotbar, ['cleaving_strike', null, null, null]);
});

test('12.A0x: PlayerSystem#_updateHoverTarget (physics.overlapCircle pick) allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { ctx } = await bootGame();
  const player = ctx.get('player');
  const actors = ctx.get('actors');

  const monster = actors.spawn({ kind: 'monster', archetypeId: 'bone_ranker', team: 1, x: 5, z: 5, facing: 0, level: 1 });
  player._cursor.x = monster.x;
  player._cursor.z = monster.z;

  const runOneCall = () => player._updateHoverTarget(ctx);

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `_updateHoverTarget allocation (O-43): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `_updateHoverTarget must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
      `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
  assert.equal(player.hoverTarget, monster.id);
});
