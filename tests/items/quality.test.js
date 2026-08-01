// tests/items/quality.test.js
//
// ITEM-4 acceptance tests for src/items/quality.js, src/items/rng.js and
// the fork ItemsSystem.init() takes (src/items/index.js). `node:test` +
// `node:assert/strict` only, matching every sibling test file in this repo
// (tests/items/bases.test.js, tests/items/affixes.test.js,
// tests/items/treasure.test.js).
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief):
//   1. `ItemsSystem.init()` takes the `items` fork exactly once, from
//      `ctx.rng.fork()`.
//   2. A `CountingRng` wrapper proves `rollQuality` consumes exactly ONE
//      draw, regardless of which rarity it returns (D-6).
//   3. The quality ladder of 04-items.md §4.1 is exercised deterministically
//      against every reachable bucket of the three §4.5 example profiles,
//      including profile (c)'s truncation (superior/normal unreachable).
//   4. 1,000,000 Monte Carlo draws per §4.5 profile reproduce the three
//      tables inside lootsim's R1 tolerance (04 §10.2: ±0.30pp `unique`,
//      ±1.0pp everything else) — NOT the backlog's ±0.05pp, which R1
//      supersedes per this ticket's brief.
//   5. Magic Find's diminishing-returns curve (§4.3) matches the published
//      table for `unique`/`rare`, and `magic`/`superior` follow their
//      documented linear/flat rule (D-7).
//
// NOT tested here (owned by later M3 tickets): base/affix rolling,
// degradation (`degrade()`, ITEM-5), unique substitution, ground scatter.
// Rule O-27: this file asserts ITEM-4's own contract only.
//
// PROGRESS D-20: MF 400 does not exist — no legal gear exceeds 172%. This
// file never constructs an MF-400 (or higher) case; the cap-clamp branches
// of `rollQuality` are exercised only through the three legal §4.5
// profiles, never through a synthetic illegal MF value.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { rollQuality, effMF, QUALITY_BASE, QUALITY_CAP } from '../../src/items/quality.js';
import { CountingRng } from '../../src/items/rng.js';
import { ItemsSystem } from '../../src/items/index.js';

test('ITMS.Q00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof rollQuality, 'function');
});

// ---------------------------------------------------------------------------
// 1. The fork
// ---------------------------------------------------------------------------

test('ITMS.Q01 ItemsSystem.init() takes ctx.rng.fork() exactly once', async () => {
  const root = new Rng(0xc0ffee);
  let forkCalls = 0;
  const ctx = {
    rng: new Proxy(root, {
      get(target, prop, receiver) {
        if (prop === 'fork') {
          return (...args) => {
            forkCalls++;
            return Rng.prototype.fork.apply(target, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }),
  };

  const sys = new ItemsSystem();
  await sys.init(ctx);

  assert.equal(forkCalls, 1, 'ctx.rng.fork() must be called exactly once by init()');
  assert.ok(sys.rng instanceof Rng, 'the forked stream must be kept on the instance');
  assert.notEqual(sys.rng, ctx.rng, 'the fork must be an independent stream, not ctx.rng itself');
});

// ---------------------------------------------------------------------------
// 2. D-6 — one draw, proven by instrumentation
// ---------------------------------------------------------------------------

test('ITMS.Q02 rollQuality consumes exactly one draw, across every reachable rarity', () => {
  // Deliberately spans all five outcomes (unique/rare/magic/superior/normal)
  // by varying rank/difficulty/magicFind across legal, §4.5-style inputs —
  // never an MF value above the 172% catalogue cap (PROGRESS D-20).
  const cases = [
    { ilvl: 5, mlvl: 5, rank: 'normal', difficulty: 'instruction', mf: 0 },
    { ilvl: 22, mlvl: 20, rank: 'champion', difficulty: 'instruction', mf: 50 },
    { ilvl: 30, mlvl: 27, rank: 'boss', difficulty: 'trial', mf: 75 },
    { ilvl: 10, mlvl: 10, rank: 'minion', difficulty: 'renunciation', mf: 100 },
    { ilvl: 8, mlvl: 8, rank: 'urn', difficulty: 'instruction', mf: 0 },
  ];

  for (const c of cases) {
    const counting = new CountingRng(new Rng(0xabcdef));
    const before = counting.draws;
    rollQuality(c.ilvl, c.mlvl, c.rank, c.difficulty, c.mf, counting);
    assert.equal(
      counting.draws - before,
      1,
      `rollQuality(${JSON.stringify(c)}) must consume exactly one draw`,
    );
  }
});

test('ITMS.Q02b one draw holds over many consecutive calls on the same stream (cumulative accounting)', () => {
  const counting = new CountingRng(new Rng(777));
  const N = 5000;
  for (let i = 0; i < N; i++) {
    rollQuality(5, 5, 'normal', 'instruction', 0, counting);
  }
  assert.equal(counting.draws, N, 'N calls must consume exactly N draws, not 4N (four-roll misreading) or 0');
});

// ---------------------------------------------------------------------------
// 3. The ladder — deterministic, boundary-exercising, against the three
//    §4.5 example profiles (values quoted from the spec table, not
//    recomputed independently, so this test would catch a formula
//    regression the same way the spec's own worked examples would).
// ---------------------------------------------------------------------------

function fixedRng(value) {
  return { next: () => value };
}

test('ITMS.Q03a profile (a) — level 5 normal monster, Instruction, MF 0: every bucket reachable at its documented share', () => {
  // 04 §4.5a: unique .25%, rare 1.80%, magic 16.00%, superior 20.00%, normal 61.95%
  // cumulative: 0.0025, 0.0205, 0.1805, 0.3805
  const args = [5, 5, 'normal', 'instruction', 0];
  assert.equal(rollQuality(...args, fixedRng(0.001)), 'unique');
  assert.equal(rollQuality(...args, fixedRng(0.01)), 'rare');
  assert.equal(rollQuality(...args, fixedRng(0.1)), 'magic');
  assert.equal(rollQuality(...args, fixedRng(0.3)), 'superior');
  assert.equal(rollQuality(...args, fixedRng(0.5)), 'normal');
  assert.equal(rollQuality(...args, fixedRng(0.999999)), 'normal');
});

test('ITMS.Q03b profile (b) — level 20 champion, Instruction, MF 50: every bucket reachable', () => {
  // 04 §4.5b: unique 1.063%, rare 6.698%, magic 42.240%, superior 23.920%, normal 26.080%
  // cumulative: 0.010625, 0.077601, 0.500001, 0.739201
  const args = [22, 20, 'champion', 'instruction', 50];
  assert.equal(rollQuality(...args, fixedRng(0.005)), 'unique');
  assert.equal(rollQuality(...args, fixedRng(0.05)), 'rare');
  assert.equal(rollQuality(...args, fixedRng(0.3)), 'magic');
  assert.equal(rollQuality(...args, fixedRng(0.6)), 'superior');
  assert.equal(rollQuality(...args, fixedRng(0.9)), 'normal');
});

test('ITMS.Q03c profile (c) — Molgrim on Trial, MF 75: the ladder truncates, superior/normal unreachable', () => {
  // 04 §4.5c: unique 6.365%, rare 30.826%, magic 62.809% (truncated, magic
  // itself capped at CAP.magic=0.95 before the ladder even sums), superior
  // 0%, normal 0% — this is §4.1's truncation behaviour by design.
  const args = [30, 27, 'boss', 'trial', 75];
  assert.equal(rollQuality(...args, fixedRng(0.03)), 'unique');
  assert.equal(rollQuality(...args, fixedRng(0.2)), 'rare');
  assert.equal(rollQuality(...args, fixedRng(0.9)), 'magic');
  // Even at the very top of the [0,1) range, the ladder never reaches
  // superior or normal for this profile.
  assert.equal(rollQuality(...args, fixedRng(0.999999)), 'magic');
});

// ---------------------------------------------------------------------------
// 4. R1 — 1,000,000-draw Monte Carlo per §4.5 profile, inside lootsim's R1
//    tolerance (04 §10.2): ±0.30pp absolute for `unique`, ±1.0pp for the
//    rest. This ticket's brief is explicit that R1, not the backlog's
//    ±0.05pp, is the bar — ±0.05pp is 6-20x tighter than R1 and not
//    attainable at 10^6 draws.
// ---------------------------------------------------------------------------

const N = 1_000_000;
const RARITIES = ['unique', 'rare', 'magic', 'superior', 'normal'];

function simulate(seed, ilvl, mlvl, rank, difficulty, mf) {
  const counting = new CountingRng(new Rng(seed));
  const counts = { unique: 0, rare: 0, magic: 0, superior: 0, normal: 0 };
  for (let i = 0; i < N; i++) {
    const rarity = rollQuality(ilvl, mlvl, rank, difficulty, mf, counting);
    counts[rarity]++;
  }
  return { counts, draws: counting.draws };
}

function tolFor(rarity) {
  return rarity === 'unique' ? 0.30 : 1.0; // percentage points
}

test('ITMS.Q04a R1 — profile (a) reproduces §4.5a inside tolerance', () => {
  const expected = { unique: 0.250, rare: 1.800, magic: 16.000, superior: 20.000, normal: 61.950 };
  const { counts, draws } = simulate(1, 5, 5, 'normal', 'instruction', 0);
  assert.equal(draws, N, 'draw-count determinism: exactly one draw per call, N calls');
  for (const r of RARITIES) {
    const observed = (counts[r] / N) * 100;
    const dev = Math.abs(observed - expected[r]);
    // eslint-disable-next-line no-console
    console.log(`  Q04a ${r}: expected ${expected[r].toFixed(3)}%  observed ${observed.toFixed(4)}%  dev ${dev.toFixed(4)}pp  (tol ${tolFor(r)}pp)`);
    assert.ok(dev <= tolFor(r), `${r}: deviation ${dev.toFixed(4)}pp exceeds R1 tolerance ${tolFor(r)}pp`);
  }
});

test('ITMS.Q04b R1 — profile (b) reproduces §4.5b inside tolerance', () => {
  const expected = { unique: 1.063, rare: 6.698, magic: 42.240, superior: 23.920, normal: 26.080 };
  const { counts, draws } = simulate(2, 22, 20, 'champion', 'instruction', 50);
  assert.equal(draws, N);
  for (const r of RARITIES) {
    const observed = (counts[r] / N) * 100;
    const dev = Math.abs(observed - expected[r]);
    // eslint-disable-next-line no-console
    console.log(`  Q04b ${r}: expected ${expected[r].toFixed(3)}%  observed ${observed.toFixed(4)}%  dev ${dev.toFixed(4)}pp  (tol ${tolFor(r)}pp)`);
    assert.ok(dev <= tolFor(r), `${r}: deviation ${dev.toFixed(4)}pp exceeds R1 tolerance ${tolFor(r)}pp`);
  }
});

test('ITMS.Q04c R1 — profile (c) reproduces §4.5c inside tolerance, including truncation', () => {
  const expected = { unique: 6.365, rare: 30.826, magic: 62.809, superior: 0, normal: 0 };
  const { counts, draws } = simulate(3, 30, 27, 'boss', 'trial', 75);
  assert.equal(draws, N);
  for (const r of RARITIES) {
    const observed = (counts[r] / N) * 100;
    const dev = Math.abs(observed - expected[r]);
    // eslint-disable-next-line no-console
    console.log(`  Q04c ${r}: expected ${expected[r].toFixed(3)}%  observed ${observed.toFixed(4)}%  dev ${dev.toFixed(4)}pp  (tol ${tolFor(r)}pp)`);
    assert.ok(dev <= tolFor(r), `${r}: deviation ${dev.toFixed(4)}pp exceeds R1 tolerance ${tolFor(r)}pp`);
  }
  // The truncation itself: superior and normal must be exactly zero, not
  // merely small — 04 §4.1's "once the running total reaches 1.0 the lower
  // rarities become unreachable" is a hard guarantee, not a probabilistic one.
  assert.equal(counts.superior, 0, 'superior must be exactly unreachable on profile (c)');
  assert.equal(counts.normal, 0, 'normal must be exactly unreachable on profile (c)');
});

// ---------------------------------------------------------------------------
// 5. Magic Find curve (§4.3) and D-7 (MF does not touch superior)
// ---------------------------------------------------------------------------

test('ITMS.Q05 effMF matches the §4.3 table for unique and rare', () => {
  // magicFind -> [effMF unique, effMF rare], read off the §4.3 table.
  const rows = [
    [25, 22.73, 23.91],
    [50, 41.67, 45.83],
    [75, 57.69, 66.00],
    [100, 71.43, 84.62],
    [150, 93.75, 117.86],
    [200, 111.11, 146.67],
    [300, 136.36, 194.12],
    [500, 166.67, 261.90],
  ];
  for (const [mf, expUnique, expRare] of rows) {
    assert.ok(Math.abs(effMF('unique', mf) - expUnique) < 0.01, `effMF(unique, ${mf})`);
    assert.ok(Math.abs(effMF('rare', mf) - expRare) < 0.01, `effMF(rare, ${mf})`);
  }
});

test('ITMS.Q05b magic is linear (no diminishing returns), superior is always flat zero (D-7)', () => {
  for (const mf of [0, 25, 100, 172]) {
    assert.equal(effMF('magic', mf), mf);
    assert.equal(effMF('superior', mf), 0);
  }
});

// ---------------------------------------------------------------------------
// Misc: fail-loudly on an unknown rank/difficulty, base table sanity
// ---------------------------------------------------------------------------

test('ITMS.Q06 rollQuality throws on an unknown rank or difficulty, before drawing', () => {
  const counting = new CountingRng(new Rng(1));
  assert.throws(() => rollQuality(5, 5, 'not_a_rank', 'instruction', 0, counting), RangeError);
  assert.equal(counting.draws, 0, 'a rejected rank must not consume a draw');

  assert.throws(() => rollQuality(5, 5, 'normal', 'not_a_difficulty', 0, counting), RangeError);
  assert.equal(counting.draws, 0, 'a rejected difficulty must not consume a draw');
});

test('ITMS.Q07 QUALITY_BASE / QUALITY_CAP match 04 §4.2 verbatim', () => {
  assert.deepEqual(QUALITY_BASE, { unique: 0.0025, rare: 0.0180, magic: 0.1600, superior: 0.2000 });
  assert.deepEqual(QUALITY_CAP, { unique: 0.25, rare: 0.50, magic: 0.95, superior: 0.60 });
});
