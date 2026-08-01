// tests/player/hudstate.perf.test.js
//
// PLYR-10's own `Alloc: no` gate for `PlayerSystem#hudState`
// (`02-api-contracts.md:1189`) — `tests/core/alloc.test.js`'s `12.A01` work
// list says a later ticket adding a new `Alloc: no` row adds its probe to
// its OWN subsystem's `.perf.test.js`, not the shared file. This is that
// probe. Named `.perf.test.js` per D-11 — picked up by `test:perf`
// (`--test-concurrency=1`, isolated) and excluded from `test:unit` by name.
//
// O-43/O-23 methodology, verbatim (see tests/combat/status.test.js's
// `12.A01` / tests/combat/resolve.perf.test.js for the identical pattern
// this file matches): a probe below ~1M iterations is noise, not signal —
// this project's own measured floor is 80.45 B/call at N=10k decaying to
// 0.325 B/call at N=4M on a genuinely allocation-free function. Sampled at
// N=1e6 and N=4e6; judged by the MARGINAL bytes between the two TOTALS (not
// either mean alone), so warm-up settling at the smaller N cannot hide
// inside the reported number.

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

test('12.A0x: hudState(out) allocates < 1 byte/call at N >= 1e6 (O-43 methodology)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const player = ctx.get('player');
  const actor = player.actor;

  // The hot path this contract row's `Alloc: no` actually gates — the
  // caller-supplied `out`, preallocated exactly once here (`09-ui.md` §D-A:
  // "ui calls player.hudState(this._hud) with a preallocated HudState"),
  // never rebuilt inside the timed closure.
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

  // Vary the live actor's life/mana every call so the measured path is the
  // real "read the live record" one, not a branch that could get folded to
  // a constant by the JIT.
  let tick = 0;
  const runOneCall = () => {
    tick = (tick + 1) & 0xff;
    actor.life = tick;
    actor.mana = 500 - tick;
    player.hudState(out);
  };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `hudState(out) allocation (O-43): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `hudState(out) must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
      `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
});

test('12.A0x: hudState() with no argument (the reused internal scratch) also stays < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const player = ctx.get('player');

  const runOneCall = () => { player.hudState(); };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `hudState() no-arg allocation (O-43): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `hudState() with no argument must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
      `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
});
