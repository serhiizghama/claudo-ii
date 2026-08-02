// tests/ui/tree.perf.test.js
//
// UI-9's own `Alloc: no` gate for `Tree#update()`'s steady per-frame path
// (`ARCHITECTURE.md` rule 6), matching every other `.perf.test.js` in this
// tree (D-11: an allocation assertion goes here, never in `tree.test.js`).
// O-43/O-23 methodology, verbatim: N=1e6 and N=4e6, judged by the MARGINAL
// bytes between the two TOTALS. Do NOT run the full `test:perf` suite from
// an agent session that isn't the orchestrator — this file alone, via
// `node --expose-gc --test tests/ui/tree.perf.test.js`, is fine
// (`sheet.perf.test.js`'s own header note, same precedent).
//
// Two steady states probed:
//   1. panel CLOSED — `update()`'s own visibility check is the only work.
//   2. panel OPEN, a node selected, nothing else changing — the worst
//      "idle" case: the header/node/detail-card sync functions all run
//      every frame (D-A: every field is polled fresh), but nothing in
//      their INPUTS changed, so every `this._t(...)` string build and
//      `describe()`-line format must be skipped, not just the DOM write —
//      see `_syncHeader`/`_syncDetailCard`'s own doc comments in
//      `src/ui/tree.js` for the exact discipline this proves.
//
// The connector canvas redraw itself is NOT on this steady path (it only
// fires on `_dirty`, proved separately in `tree.test.js`) — nothing here
// exercises a redraw.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

async function bootReady() {
  const { ctx } = await boot({ canvas: makeCanvas(), width: 1280, height: 720, deterministic: true, global: {} });
  const ui = ctx.get('ui');
  ui.setScreen('game');
  return { ctx, ui };
}

function measure(runOneCall) {
  runOneCall(); // one throwaway call before any measurement — let shapes settle
  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);
  return { atOneMillion, atFourMillion, marginalBytesPerCall };
}

test('12.Axx: Tree#update(dt,ctx) steady state, panel CLOSED, allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }
  const { ctx, ui } = await bootReady();
  assert.equal(ui._tree.isOpen(), false);

  const dt = 1 / 60;
  const runOneCall = () => { ui._tree.update(dt, ctx); };
  const { atOneMillion, atFourMillion, marginalBytesPerCall } = measure(runOneCall);

  // eslint-disable-next-line no-console
  console.log(`Tree#update (closed) allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.ok(marginalBytesPerCall < 1, `Tree#update (closed) must allocate < 1 byte/call marginally; got ${marginalBytesPerCall.toFixed(4)} B/call`);
  ui.dispose();
});

test('12.Axx: Tree#update(dt,ctx) steady state, panel OPEN with a node selected, nothing changing, allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }
  const { ctx, ui } = await bootReady();
  const player = ctx.get('player');

  // Reach level 30 through the real path (PLYR-4) so the actor's classId
  // exists and the node lattice actually builds — a fresh level-1 actor
  // has no allocated points, which is a legitimate but thinner idle state
  // than this probe wants (see tree.js's own header for why 30 is used
  // elsewhere too).
  player.grantXp(1e9, 0);
  ctx.time.step++;
  player.fixedUpdate(1 / 60, ctx);

  ui.openSkillTree();
  ui._tree.__select('whirlwind');
  const dt = 1 / 60;
  ui._tree.update(dt, ctx); // settle the first dirty redraw + the first detail-card build

  const runOneCall = () => { ui._tree.update(dt, ctx); };
  const rc0 = ui._tree.__redrawCount();
  const { atOneMillion, atFourMillion, marginalBytesPerCall } = measure(runOneCall);

  // eslint-disable-next-line no-console
  console.log(`Tree#update (open, selected, idle) allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.equal(ui._tree.__redrawCount(), rc0, 'an idle steady state must not trigger a single extra canvas redraw across 5,000,001 calls');
  assert.ok(marginalBytesPerCall < 1, `Tree#update (open, idle) must allocate < 1 byte/call marginally; got ${marginalBytesPerCall.toFixed(4)} B/call`);
  ui.dispose();
});
