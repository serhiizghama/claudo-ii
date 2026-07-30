// tests/combat/resolve.perf.test.js
//
// CMBT-3 — 12.A05: "resolve() over a 12-target flame_wave must allocate <
// 1 byte/call." Named `.perf.test.js` (not `.test.js`) so it lands in the
// isolated `--test-concurrency=1` perf stage (D-11), not the correctness
// stage.
//
// O-43: allocation probes are meaningless below ~1M iterations on this
// project's measured noise floor (a genuinely allocation-free method reads
// 80 B/call at N=10k, 0.33 B/call at N=4M — GC/JIT settling, not a leak).
// This file does NOT use tests/helpers/alloc.js's `assertAllocationFree`
// (its default `iterations: 10_000` is exactly the regime O-43 says is
// unusable) — it samples `allocatedBytes` directly at N=1e6 and N=4e6 and
// judges by TOTAL bytes growing (or not) between the two, never by the
// small-N mean.
//
// The `12-target flame_wave` scenario is simulated as 12 targets, each hit
// once per outer iteration with a REUSED packet and a REUSED `out`
// DamageResult (the explicitly zero-alloc call shape — `out` supplied means
// resolve() never touches the pool at all, which is exactly how a real
// hot-path caller, e.g. an AoE skill, should call it; see resolve.js's own
// header for why "Alloc: pool" only describes the no-`out` default path).

import test from 'node:test';
import assert from 'node:assert/strict';

import { allocatedBytes, hasGc } from '../helpers/alloc.js';
import { resolveDamage } from '../../src/combat/resolve.js';
import { PacketPool } from '../../src/combat/packet.js';

function makeStats() {
  return {
    defense: 67, dexterity: 20, blockChance: 0, dodgeChance: 0,
    damageReduceFlat: 1, damageReducePercent: 0, physicalResist: 0,
    fireResist: 0, maxFireResist: 75, coldResist: 0, maxColdResist: 75,
    lightResist: 0, maxLightResist: 75, poisonResist: 0, maxPoisonResist: 75,
    magicResist: 0, maxMagicResist: 75, magicDamageReduceFlat: 0,
    maxLife: 100000, maxMana: 100000, thorns: 0,
  };
}

function makeTarget(id) {
  return {
    id, generation: 0, team: 1, level: 10, flags: 0,
    x: id, y: 0, z: 0, facing: 0,
    life: 100000, mana: 0, dead: false, invulnUntil: 0,
    equipment: null, statuses: [],
    stats: makeStats(),
  };
}

function blankResult() {
  return {
    targetId: 0, targetGen: 0, sourceId: 0, sourceGen: 0, sourceSkillId: null,
    outcome: 'invalid', crit: false, blocked: false, killed: false, overkill: 0,
    physical: 0, fire: 0, cold: 0, lightning: 0, poison: 0, magic: 0, total: 0,
    lifeStolen: 0, manaStolen: 0, manaReturned: 0, thornsDealt: 0,
    statusApplied: 0, hitRecovery: false, knockedBack: false,
    pointX: 0, pointY: 0, pointZ: 0, poolIndex: -1,
  };
}

test('12.A05: resolve() over a 12-target flame_wave allocates < 1 byte/call at N >= 1e6 (O-43 methodology)', (t) => {
  if (!hasGc()) {
    t.skip('run with `node --expose-gc` to measure allocation (hasGc() === false)');
    return;
  }

  const TARGET_COUNT = 12;
  const targets = [];
  for (let i = 0; i < TARGET_COUNT; i++) targets.push(makeTarget(i + 1));

  const pool = new PacketPool(4);
  const packet = pool.acquire();
  Object.assign(packet, {
    team: 0, sourceId: 1, sourceGen: 0, sourceSkillId: 'flame_wave',
    attackRating: 0, attackerLevel: 10, blockable: false, dodgeable: false,
    critChance: 5, critMult: 200,
    physMin: 0, physMax: 0,
    fireMin: 20, fireMax: 30,
  });

  const rng = { _s: 1, next() { this._s = (this._s * 1103515245 + 12345) >>> 0; return this._s / 4294967296; }, range(min, max) { return min + this.next() * (max - min); } };
  const env = {
    source: null, rng, step: 0, actorsSystem: null, events: null,
    packetPool: null, resultPool: null,
    statusSpec: { status: null, step: 0, sourceId: 0, sourceGen: 0, sourceSkill: null, element: null, magnitude: 0, duration: 0, stacks: 1 },
    damagePayload: { target: null, source: null, result: null },
    thornsEnv: null, isThornsCounter: false,
  };
  env.thornsEnv = { ...env, thornsEnv: null, isThornsCounter: true };

  const out = blankResult();
  let targetIdx = 0;
  const runOneHit = () => {
    const target = targets[targetIdx];
    targetIdx = (targetIdx + 1) % TARGET_COUNT;
    if (target.life < 1000) target.life = 100000; // never let a target actually die mid-measurement
    env.step++;
    resolveDamage(packet, target, env, out);
  };

  const atOneMillion = allocatedBytes(runOneHit, 1_000_000);
  const atFourMillion = allocatedBytes(runOneHit, 4_000_000);

  // O-43: judge by TOTAL bytes growing between two large Ns, not the mean
  // at either N alone (both means are already expected to be tiny/noisy).
  const totalAtOne = atOneMillion * 1_000_000;
  const totalAtFour = atFourMillion * 4_000_000;
  const marginalBytesPerCall = (totalAtFour - totalAtOne) / (4_000_000 - 1_000_000);

  assert.ok(
    marginalBytesPerCall < 1,
    `resolve() must allocate < 1 byte/call marginally between N=1e6 and N=4e6; ` +
      `got ${marginalBytesPerCall.toFixed(4)} B/call (N=1e6: ${atOneMillion.toFixed(4)} B/call, N=4e6: ${atFourMillion.toFixed(4)} B/call)`,
  );
});
