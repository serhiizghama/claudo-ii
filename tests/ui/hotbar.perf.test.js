// tests/ui/hotbar.perf.test.js
//
// UI-3's own `Alloc: no` gate for the steady per-frame `update()` path
// (`ARCHITECTURE.md` rule 6). Named `.perf.test.js` per D-11 — picked up by
// `npm run test:perf` (`--test-concurrency=1`, isolated) and excluded from
// `test:unit` by name. Do NOT run the full `test:perf` suite from an agent
// session that isn't the orchestrator (see feedback.perf.test.js's own
// header) — this file alone, via
// `node --expose-gc --test tests/ui/hotbar.perf.test.js`, is fine.
//
// O-43/O-23 methodology, verbatim — matches every other `.perf.test.js` in
// this tree: a probe below ~1M iterations is noise, not signal. Sampled at
// N=1e6 and N=4e6; judged by the MARGINAL bytes between the two TOTALS.
//
// Scope: the toast queue is exactly the shape the ticket brief calls out as
// "tempting a Map" (`Pool`-based here, see hotbar.js's own header), and the
// per-slot background/cooldown-text writes are template-string-shaped —
// both are exercised here at a genuinely steady state (no cooldown active,
// no toast active, prompt/banner idle) so the change-guards this file
// relies on are actually exercised, not bypassed by constant churn.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Hotbar } from '../../src/ui/hotbar.js';
import { el } from '../../src/ui/util.js';
import { Rng } from '../../src/core/rng.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

function makeCanvas(width = 1920, height = 1080) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

function makeCtx() {
  return {
    canvas: makeCanvas(),
    rng: new Rng(12345),
    get() { return null; },
    has() { return false; },
    peek() { return undefined; },
  };
}

test('12.Axx: Hotbar#update(dt,ctx) at steady state (idle cooldowns, no toasts) allocates < 1 byte/call at N >= 1e6', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const hudLayer = el('div');
  const feedbackLayer = el('div');
  const ctx = makeCtx();
  const hb = new Hotbar(ctx, hudLayer, feedbackLayer, (k) => k, null);
  hb.setVisible(true);

  // Settle every change-guard once (icon draws, initial background writes,
  // prompt/banner idle state) before the timed loop — the same "warm up,
  // let the shapes settle" discipline `allocatedBytes` itself documents,
  // extended here to this module's own per-slot change-guards.
  for (let i = 0; i < 5; i++) hb.update(1 / 60, ctx);

  const dt = 1 / 60;
  const runOneCall = () => { hb.update(dt, ctx); };

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `Hotbar#update steady-state allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `Hotbar#update must allocate < 1 byte/call marginally at steady state; got ${marginalBytesPerCall.toFixed(4)} ` +
      `B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
});

test('12.Axx: five active toasts advancing every frame (no expiry, no rank change) allocate < 1 byte/call at N >= 1e6', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const hudLayer = el('div');
  const feedbackLayer = el('div');
  const ctx = makeCtx();
  const hb = new Hotbar(ctx, hudLayer, feedbackLayer, (k) => k, null);
  hb.setVisible(true);

  for (let i = 0; i < 5; i++) hb.toast('toast ' + i, 'info');
  assert.equal(hb.__toastActiveCount(), 5);

  // A tiny dt that never crosses the 4.0s life boundary within the probe's
  // own iteration count, so every record stays alive and at a settled
  // display position/opacity throughout — this is what makes the
  // steady-state change-guards (not the legitimate per-toast creation
  // allocation) the thing under measurement, retained the same way this
  // milestone's own "beware this measurement artifact" note requires: the
  // pool's records are held by `hb` itself (`this._toastRecords`), so a
  // minor GC cannot reclaim them out from under the probe.
  // 5e6 total calls (warm-up + both probes) at this dt sums to well under
  // TOAST_LIFE (4.0s), so nothing expires mid-probe.
  const dt = 5e-8;
  const runOneCall = () => { hb.update(dt, ctx); };

  for (let i = 0; i < 5; i++) runOneCall();

  const atOneMillion = allocatedBytes(runOneCall, 1_000_000);
  const atFourMillion = allocatedBytes(runOneCall, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(
    `Hotbar#update (5 settled toasts) allocation: N=1e6 -> ${atOneMillion.toFixed(4)} B/call, ` +
      `N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.equal(hb.__toastActiveCount(), 5, 'none of the 5 toasts may have expired during the probe');

  assert.ok(
    marginalBytesPerCall < 1,
    `Hotbar#update with 5 settled toasts must allocate < 1 byte/call marginally; got ${marginalBytesPerCall.toFixed(4)} ` +
      `B/call (N=1e6: ${atOneMillion.toFixed(4)}, N=4e6: ${atFourMillion.toFixed(4)})`,
  );
});
