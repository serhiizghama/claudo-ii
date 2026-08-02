// tests/ui/sheet.perf.test.js
//
// UI-10's own `Alloc: no` gate for `Sheet#update()`'s steady per-frame path
// (`ARCHITECTURE.md` rule 6), matching every other `.perf.test.js` in this
// tree (D-11: an allocation assertion goes here, never in `sheet.test.js`).
// O-43/O-23 methodology, verbatim: N=1e6 and N=4e6, judged by the MARGINAL
// bytes between the two TOTALS. Do NOT run the full `test:perf` suite from
// an agent session that isn't the orchestrator — this file alone, via
// `node --expose-gc --test tests/ui/sheet.perf.test.js`, is fine
// (`inventory.perf.test.js`'s own header note, same precedent).
//
// Two steady states probed:
//   1. panel CLOSED — `_syncViewport`'s polling comparison is the only
//      work; must be allocation-free (and near-zero cost).
//   2. panel OPEN, advanced page also open — the sheet's own worst-case
//      shape (10 equipment slots + attributes + vessels + resistances +
//      26 advanced rows all read every frame), nothing changing.
//
// `_syncStats`'s own header comment (src/ui/sheet.js) explains WHY this is
// the interesting case to gate: `t(key, params)` always builds a fresh
// string, so unlike a plain `setText` (already change-guarded on the write)
// the STRING BUILD itself has to be skipped in steady state, not just the
// DOM write — this file is what proves that guard actually holds.

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

test('12.Axx: Sheet#update(dt,ctx) steady state, panel CLOSED, allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }
  const { ctx, ui } = await bootReady();
  assert.equal(ui._sheet.isOpen(), false);

  const dt = 1 / 60;
  const runOneCall = () => { ui._sheet.update(dt, ctx); };
  const { atOneMillion, atFourMillion, marginalBytesPerCall } = measure(runOneCall);

  // eslint-disable-next-line no-console
  console.log(`Sheet#update (closed) allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.ok(marginalBytesPerCall < 1, `Sheet#update (closed) must allocate < 1 byte/call marginally; got ${marginalBytesPerCall.toFixed(4)} B/call`);
  ui.dispose();
});

test('12.Axx: Sheet#update(dt,ctx) steady state, panel OPEN with the advanced page open too, allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }
  const { ctx, ui } = await bootReady();
  ui.toggleCharacterSheet();
  assert.equal(ui._sheet.isOpen(), true);

  // Open the advanced page the same way a real click on the toggle button
  // would, so the 26-row advanced block is part of the steady state this
  // probe measures — the worst-case shape `sheet.js`'s own node-budget
  // header names.
  ui._sheet._advancedOpen = true;
  ui._sheet._advWrapEl && (ui._sheet._advWrapEl.style.display = 'block');

  for (let i = 0; i < 5; i++) ui._sheet.update(1 / 60, ctx);

  const dt = 1 / 60;
  const runOneCall = () => { ui._sheet.update(dt, ctx); };
  const { atOneMillion, atFourMillion, marginalBytesPerCall } = measure(runOneCall);

  // eslint-disable-next-line no-console
  console.log(`Sheet#update (open, advanced) allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.ok(ui._sheet.__advancedOpen(), 'sanity: the advanced page must still be open throughout the probe');
  assert.ok(marginalBytesPerCall < 1, `Sheet#update (open, advanced) must allocate < 1 byte/call marginally; got ${marginalBytesPerCall.toFixed(4)} B/call`);
  ui.dispose();
});

test('12.Axx: Sheet#update(dt,ctx) steady state, panel OPEN, base page (advanced closed), allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) { t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)'); return; }
  const { ctx, ui } = await bootReady();
  ui.toggleCharacterSheet();
  for (let i = 0; i < 5; i++) ui._sheet.update(1 / 60, ctx);

  const dt = 1 / 60;
  const runOneCall = () => { ui._sheet.update(dt, ctx); };
  const { atOneMillion, atFourMillion, marginalBytesPerCall } = measure(runOneCall);

  // eslint-disable-next-line no-console
  console.log(`Sheet#update (open, base page) allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.ok(marginalBytesPerCall < 1, `Sheet#update (open, base) must allocate < 1 byte/call marginally; got ${marginalBytesPerCall.toFixed(4)} B/call`);
  ui.dispose();
});
