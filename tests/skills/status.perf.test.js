// tests/skills/status.perf.test.js
//
// SKIL-6 — allocation probes for `src/skills/status.js`'s pure/near-pure
// engine functions (O-43/O-23 methodology, N >= 1e6,
// `tests/helpers/alloc.js#assertAllocationFree`). None of these are
// `02-api-contracts.md` contract rows (this file adds no new public
// `skills` method — see `status.js`'s own header), so there is no single
// documented `Alloc:` column to cite; the bar is `ARCHITECTURE.md` rule 6
// ("allocate nothing per-frame") applied to the functions this ticket's own
// header commits to being zero-allocation: `populateFixedMagnitudeRiders`
// mutates already-pooled packet slots in place, and the small pure-math
// helpers (`essenceBurnDamagePerManaSpent`, `computeEssenceBurnDamage`,
// `computeIncinerateDetonationPercent`, `isKnownStatus`,
// `isValidStatusMagnitude`, `isValidStatusDuration`, `buildStatusSpec`)
// touch nothing but function-local primitives and an already-existing
// object.
//
// Node-safe: no `three`, no DOM/browser global anywhere in this file.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assertAllocationFree, hasGc } from '../helpers/alloc.js';
import {
  populateFixedMagnitudeRiders,
  computeEssenceBurnDamage,
  essenceBurnDamagePerManaSpent,
  computeIncinerateDetonationPercent,
  isKnownStatus,
  isValidStatusMagnitude,
  isValidStatusDuration,
  buildStatusSpec,
} from '../../src/skills/status.js';
import { boot } from '../../src/main.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

test('SKIL-6 perf — status.js pure engine functions allocate < 1 byte/call (O-43, N >= 1e6)', async (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const skills = ctx.get('skills');
  const combat = ctx.get('combat');

  const sunderDef = skills.definition('sunder');
  const essenceDef = skills.definition('essence_burn');
  const incinerateDef = skills.definition('incinerate');

  // A real, already-pooled packet — `populateFixedMagnitudeRiders` mutates
  // its `onHitStatus[]` slots in place; never a fresh packet per call.
  const packet = combat.scratchPacket();
  let sink;

  const statusSpecFields = { status: 'bleeding', step: 0, sourceId: 0, sourceGen: 0, sourceSkill: null, element: null, magnitude: 0, duration: 0, stacks: 1 };

  const PROBES = [
    { name: 'populateFixedMagnitudeRiders(packet, sunder def, L20)', iterations: 2_000_000, fn: () => { sink = populateFixedMagnitudeRiders(packet, sunderDef, 20); } },
    { name: 'computeEssenceBurnDamage(def, 20, 354)', iterations: 2_000_000, fn: () => { sink = computeEssenceBurnDamage(essenceDef, 20, 354); } },
    { name: 'essenceBurnDamagePerManaSpent(def, 20)', iterations: 2_000_000, fn: () => { sink = essenceBurnDamagePerManaSpent(essenceDef, 20); } },
    { name: 'computeIncinerateDetonationPercent(def, 20, 80)', iterations: 2_000_000, fn: () => { sink = computeIncinerateDetonationPercent(incinerateDef, 20, 80); } },
    { name: "isKnownStatus('cursed')", iterations: 2_000_000, fn: () => { sink = isKnownStatus('cursed'); } },
    { name: "isValidStatusMagnitude('cursed', 59)", iterations: 2_000_000, fn: () => { sink = isValidStatusMagnitude('cursed', 59); } },
    { name: "isValidStatusDuration('cursed', 6.0)", iterations: 2_000_000, fn: () => { sink = isValidStatusDuration('cursed', 6.0); } },
    { name: 'buildStatusSpec(existingFieldsObject)', iterations: 2_000_000, fn: () => { statusSpecFields.step = 0; sink = buildStatusSpec(statusSpecFields); } },
  ];

  const results = [];
  for (const probe of PROBES) {
    const { bytesPerCall, rounds } = assertAllocationFree(probe.fn, { iterations: probe.iterations, maxRounds: 40 });
    results.push({ name: probe.name, bytesPerCall, rounds });
    console.log(`[SKIL-6 perf] ${probe.name}: ${bytesPerCall.toFixed(4)} B/call, converged in ${rounds} round(s) @ N=${probe.iterations}`);
    assert.ok(bytesPerCall < 1, `${probe.name} must allocate < 1 byte/call; got ${bytesPerCall.toFixed(4)}`);
  }

  assert.equal(results.length, PROBES.length);
  void sink;
});
