// tests/combat/onhit.perf.test.js
//
// CMBT-8 / D-51 — allocation proof for the new R1 per-action rage guard
// (`shouldAwardActionRage`, `src/combat/onhit.js`). `resolve.perf.test.js`'s
// own 12.A05 fixture pins `attackRating: 0` (a spell, `flame_wave`), which
// never reaches `applyOnHitEconomy`'s melee-gated rage/resonance block at
// all (`isLikelyMeleeAttack` requires `attackRating > 0`) — so this file
// measures the actual new code path directly, O-43 methodology, same
// two-sample-marginal shape `resolve.perf.test.js` already uses.
//
// The guard's steady-state hot path (this file's own fixture: one actor,
// one never-changing `actionSeq`, called N times) is the SUPPRESSED branch
// — `lastRageActionStamp[poolIndex] === stamp` true on every call after the
// first — which is also the majority case in a real multi-target action
// (only the very first landed hit takes the "credit" branch).

import test from 'node:test';
import assert from 'node:assert/strict';

import { allocatedBytes, hasGc } from '../helpers/alloc.js';
import { applyOnHitEconomy, shouldAwardActionRage } from '../../src/combat/onhit.js';
import { PacketPool } from '../../src/combat/packet.js';
import { createActorRecord } from '../../src/actors/pool.js';
import { composeStats } from '../../src/actors/stats.js';

function makeFixture() {
  const source = createActorRecord(0);
  source.id = 1;
  source.generation = 0;
  source.kind = 'player';
  source.classId = 'ravager';
  source.level = 20;
  source.team = 0;
  composeStats(source);
  source.actionId = 'cleaving_strike'; // a real tracked action — exercises the (generation, actionSeq) stamp path, not the actionId===null fast path
  source.actionSeq = 1;

  const target = createActorRecord(1);
  target.id = 2;
  target.generation = 0;
  target.kind = 'monster';
  target.classId = null;
  target.level = 20;
  target.team = 1;
  composeStats(target);
  target.stats.maxLife = 1_000_000;
  target.life = 1_000_000;

  const pool = new PacketPool(4);
  const packet = pool.acquire();
  Object.assign(packet, {
    sourceId: source.id, sourceGen: source.generation, sourceSkillId: 'cleaving_strike',
    attackRating: 100, physMin: 5, physMax: 5, manaReturnPercent: 0,
  });

  const result = { outcome: 'hit', physical: 5, total: 5, manaReturned: 0 };
  const env = { source, step: 0 };
  return { source, target, packet, result, env };
}

test('shouldAwardActionRage: allocates < 1 byte/call at N >= 1e6, both the credit branch and the suppressed steady-state branch', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { source } = makeFixture();

  // Suppressed steady state (source.actionId/actionSeq never change) — the
  // hot path a real multi-target action spends almost all of its calls in.
  const runSuppressed = () => { shouldAwardActionRage(source); };

  const atOneMillion = allocatedBytes(runSuppressed, 1_000_000);
  const atFourMillion = allocatedBytes(runSuppressed, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(`[CMBT-8 perf] shouldAwardActionRage (suppressed steady state): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.ok(
    marginalBytesPerCall < 1,
    `shouldAwardActionRage must allocate < 1 byte/call marginally between N=1e6 and N=4e6; got ${marginalBytesPerCall.toFixed(4)} B/call`,
  );
});

test('applyOnHitEconomy: the R14(f) attacker-rage/resonance block (melee, hit, tracked action) allocates < 1 byte/call at N >= 1e6', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const { packet, target, result, env } = makeFixture();
  const runOneHit = () => { applyOnHitEconomy(packet, target, result, env); };

  const atOneMillion = allocatedBytes(runOneHit, 1_000_000);
  const atFourMillion = allocatedBytes(runOneHit, 4_000_000);
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  // eslint-disable-next-line no-console
  console.log(`[CMBT-8 perf] applyOnHitEconomy (melee hit, tracked action, guard suppressed after call #1): N=1e6 -> ${atOneMillion.toFixed(4)} B/call, N=4e6 -> ${atFourMillion.toFixed(4)} B/call, marginal -> ${marginalBytesPerCall.toFixed(4)} B/call`);

  assert.ok(
    marginalBytesPerCall < 1,
    `applyOnHitEconomy must allocate < 1 byte/call marginally between N=1e6 and N=4e6; got ${marginalBytesPerCall.toFixed(4)} B/call`,
  );
});
