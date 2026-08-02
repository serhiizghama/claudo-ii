// tests/ui/target.perf.test.js
//
// UI-8's own `Alloc: no` gate for the steady per-frame `update()` path
// (`ARCHITECTURE.md` rule 6). Named `.perf.test.js` per D-11 — picked up by
// `npm run test:perf` (`--test-concurrency=1`, isolated) and excluded from
// `test:unit` by name. Do NOT run the full `test:perf` suite from an agent
// session that isn't the orchestrator (see feedback.perf.test.js's own
// header) — this file alone, via
// `node --expose-gc --test tests/ui/target.perf.test.js`, is fine.
//
// O-43/O-23 methodology — matches every other `.perf.test.js` in this tree:
// a probe below ~1M iterations is noise, not signal; judged by the MARGINAL
// bytes between two TOTALS, not either mean alone.
//
// O-85: allocation assertions in the unit/perf stage have flaked under
// concurrency four times already (four different tickets). If this file
// fails, re-run it ALONE before concluding anything (`node --expose-gc
// --test tests/ui/target.perf.test.js`), per that ruling.
//
// Scope: exercises the FULL steady state — a boss target bar (all five
// widgets: fill/ghost damp, phase ticks, no chips, immunity marks, boss
// percentage) plus a buff strip with one debuff and one buff both active
// and mid-depletion (the radial sweep, the sub-2s pulse, the remaining/
// stack text) — the worst-case combination this module's `update()` can be
// asked to do every frame, not an idle no-op path.
//
// ---------------------------------------------------------------------------
// O-93 — N=1e6/N=4e6 was too small a window for THIS scenario; raised, the
// threshold was NOT touched
// ---------------------------------------------------------------------------
// UI-9's orchestrator measured this file flaky in isolation (3 runs: pass,
// pass, FAIL) despite passing reliably inside the full suite. Isolating
// `Target#_updateTargetBar` alone (the boss fill/ghost `scaleX(...)` writes
// — `boss.life` cycles every call here by design, so `fillQ`/`ghostQ`
// change on 50-88% of calls, confirmed by direct instrumentation) showed
// the TOTAL bytes allocated over a fixed-size call window stayed roughly
// CONSTANT (~16 MB) as N grew from 4e6 to 8e6 to 16e6, rather than scaling
// linearly with N the way a genuine per-call leak would (linear growth
// would mean the MEAN never drops, no matter how large N gets). A flat
// total that dilutes as `total/N` is exactly O-43's decay signature, just
// with a much larger constant than the reference curve (`80.45 -> 17.88 ->
// 0.391 -> 0.325 B/call` at `10k -> 100k -> 1M -> 4M`) — this widget's own
// curve does not clear 1 byte/call until N is in the 8-16 million range:
//
//   N=1e6:  0.69 - 8.88 B/call (run-to-run noise, sometimes > 1)
//   N=4e6:  0.34 - 1.77 B/call (still occasionally > 1)
//   N=8e6:  0.06 - 1.89 B/call (still occasionally > 1)
//   N=16e6: 0.11 - 0.98 B/call (consistently < 1, thin margin)
//   marginal(N=8e6, N=32e6), 2 independent runs: -0.15 B/call, +0.18 B/call
//
// Extending the WARM-UP alone (tried up to 6,000,000 calls before the
// N=1e6/N=4e6 window) did NOT fix it — the per-window mean stayed ~3-4.5
// B/call regardless of how much warm-up preceded it, ruling out "one-time
// JIT/hidden-class settling absorbed by a longer warm-up" as the whole
// story. What actually clears the threshold, reliably, is a bigger
// MEASUREMENT WINDOW (`total(N2) - total(N1)`) — raising N1/N2 to 8e6/32e6
// dilutes whatever intermittent, bounded-size cost this is (almost
// certainly V8/Node heap-segment growth events, not a per-call code
// allocation — a real per-call leak would make TOTAL bytes scale with N,
// which is the opposite of what was measured) down to comfortably under
// 1 byte/call with real margin. Nothing in `src/ui/target.js` changed —
// that file is out of this ticket's file grant, and the total-bytes-vs-N
// evidence above rules out a real per-call leak there, so there was
// nothing to fix in it. Only the two lines below (`WARM_UP_CALLS`, `N1`/
// `N2`) moved; `< 1` (never touched) is the same threshold this test
// shipped with.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { allocatedBytes, hasGc } from '../helpers/alloc.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

test('12.Axx: UiSystem#lateUpdate at steady state (boss target bar mid-drain + buff strip with a debuff and a pulsing buff) allocates < 1 byte/call at N >= 1e6', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  const skills = ctx.get('skills');
  const player = ctx.get('player');
  ui.setScreen('game');

  // Boss target bar, mid-drain (so fill/ghost keep damping every frame —
  // the steady-state worst case, not a settled bar).
  ui.debugState('target_boss');
  const boss = ui._target._targetActor;
  boss.stats.maxLife = 1000;
  boss.life = 550;

  // One buff (mid-depletion, about to enter the sub-5s "remaining" text and
  // sub-2s pulse windows across the run) and one debuff, both active.
  ctx.time.step = 5000;
  skills.applyBuff(player.actor, 'last_stand', 5, 3.0); // starts < 5s so the remaining text + pulse paths are both live from frame 1
  player.actor.statuses.push({
    status: 'burning', sourceId: 1, sourceGen: 1, sourceSkill: 'x', element: 'fire',
    magnitude: 5, stacks: 2, appliedStep: ctx.time.step, expiresStep: ctx.time.step + 180,
    nextTickStep: 0, totalRemaining: 100, statMods: null, poolIndex: -1,
  });

  const dt = 1 / 60;
  // Warm up every change-guard (icon draws, initial background writes,
  // layout) before the timed loop — the same discipline
  // ./hotbar.perf.test.js's own header documents.
  for (let i = 0; i < 5; i++) { ui.lateUpdate(dt, ctx); ctx.time.step++; }

  const runOneCall = () => {
    boss.life = 550 + (ctx.time.step % 60); // keeps the fill/ghost damp genuinely moving, never fully settled
    ctx.time.step++;
    ui.lateUpdate(dt, ctx);
  };

  // O-93 — N1/N2 raised from 1e6/4e6 to 8e6/32e6; see this file's own
  // header for the total-bytes-vs-N evidence that decided this was the
  // right axis to move (never the `< 1` threshold below).
  const N1 = 8_000_000;
  const N2 = 32_000_000;
  const atN1 = allocatedBytes(runOneCall, N1);
  const atN2 = allocatedBytes(runOneCall, N2);
  const totalAtN1 = atN1 * N1;
  const totalAtN2 = atN2 * N2;
  const marginalBytesPerCall = (totalAtN2 - totalAtN1) / (N2 - N1);

  // eslint-disable-next-line no-console
  console.log(
    `UiSystem#lateUpdate (target bar + buff strip) steady-state allocation: N=${N1} -> ${atN1.toFixed(4)} B/call, ` +
      `N=${N2} -> ${atN2.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`,
  );

  assert.ok(
    marginalBytesPerCall < 1,
    `UiSystem#lateUpdate must allocate < 1 byte/call marginally at steady state; got ${marginalBytesPerCall.toFixed(4)} ` +
      `B/call (N=${N1}: ${atN1.toFixed(4)}, N=${N2}: ${atN2.toFixed(4)})`,
  );

  ui.dispose();
});
