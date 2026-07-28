// tests/core/rng.test.js
//
// CORE-5 acceptance tests for src/core/rng.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).
//
// A note on "reference vectors": the acceptance criterion for this ticket
// asks for "reference vectors for xoshiro128**". The specs (checked:
// 02-api-contracts.md, 03-combat-math.md §12, ARCHITECTURE.md) name the
// algorithm but do not publish any numeric test vector, and inventing one
// that merely *looks* authoritative would let this test rubber-stamp a bug
// in the implementation it's supposed to be checking. So this file does two
// separate things instead:
//
//   1. Checks the algorithm via properties that hold for xoshiro128**
//      regardless of seed (integer range, non-degeneracy, determinism from
//      a given seed) — these would catch a broken port even without any
//      external number to compare against.
//   2. Pins one literal sequence (`REFERENCE_VECTOR` below) captured by
//      running *this repo's own* `src/core/rng.js` at a fixed seed. That
//      value was NOT taken from an external/canonical xoshiro128**
//      implementation — none was available — so it does not prove this port
//      matches the reference C code bit-for-bit. What it does buy: any
//      future refactor that silently changes the output stream (reordered
//      state update, wrong rotate amount, a `Math.imul` dropped somewhere)
//      turns this test red immediately, which is the regression net the
//      determinism contract (ARCHITECTURE.md § Determinism contract, "a
//      seed must reproduce a run exactly") depends on.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../../src/core/rng.js';

// Captured from `new Rng(0x5eed1234).u32()` called 8 times in a row, i.e.
// the exact seed `11-flows.md` uses for `config.deterministic` boot
// (`ctx.rng = new Rng(config.deterministic ? 0x5eed1234 : worldSeed)`).
// Self-derived, see the file header — not an external reference.
const REFERENCE_SEED = 0x5eed1234;
const REFERENCE_VECTOR = [
  3044329084, 310122175, 4160151315, 1336698532,
  1278239733, 3962496466, 1729145698, 1191405156,
];

test('xoshiro128** — same seed reproduces the same literal output sequence', () => {
  const rng = new Rng(REFERENCE_SEED);
  const out = [];
  for (let i = 0; i < REFERENCE_VECTOR.length; i++) out.push(rng.u32());
  assert.deepEqual(out, REFERENCE_VECTOR);
});

test('xoshiro128** — every raw output is an integer in [0, 2**32)', () => {
  const rng = new Rng(123456789);
  for (let i = 0; i < 20000; i++) {
    const v = rng.u32();
    assert.ok(Number.isInteger(v));
    assert.ok(v >= 0 && v < 4294967296);
  }
});

test('xoshiro128** — a given seed always expands to the same state and reproduces the same sequence', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.u32(), b.u32());
});

test('xoshiro128** — different seeds diverge', () => {
  const a = new Rng(1);
  const b = new Rng(2);
  // Extremely unlikely for two different seeds to agree on the very first
  // draw; if they do, the seed expansion is broken (e.g. ignoring the seed).
  assert.notEqual(a.u32(), b.u32());
});

test('xoshiro128** — state never degenerates to all-zero, including the seed=0 edge case', () => {
  // seed=0 is the one input where a naive port (e.g. seeding state directly
  // from the seed instead of expanding it) would produce the all-zero
  // state, which is a fixed point xoshiro128** can never escape (every
  // update is xor/shift of the current words, and 0 ^ 0 = 0 always).
  const seeds = [0, 1, -1 >>> 0, 0xffffffff, 12345, 0x5eed1234];
  for (const seed of seeds) {
    const rng = new Rng(seed);
    assert.notEqual((rng.s0 | rng.s1 | rng.s2 | rng.s3) >>> 0, 0, `seed ${seed} produced an all-zero state`);
    // and it has to stay escapable / actually vary over a run, not just at
    // t=0 — pull a couple hundred words and make sure they're not all equal
    // (which would indicate a stuck/degenerate generator).
    const first = rng.u32();
    let allSame = true;
    for (let i = 0; i < 200; i++) {
      if (rng.u32() !== first) { allSame = false; break; }
    }
    assert.ok(!allSame, `seed ${seed} produced a constant stream`);
  }
});

test('next() stays in [0, 1)', () => {
  const rng = new Rng(7);
  for (let i = 0; i < 50000; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1);
  }
});

test('int(a, b) — both ends inclusive, never out of bounds, and every value in range is reachable', () => {
  const rng = new Rng(9001);
  const min = -3;
  const max = 4;
  const seen = new Set();
  for (let i = 0; i < 20000; i++) {
    const v = rng.int(min, max);
    assert.ok(Number.isInteger(v));
    assert.ok(v >= min && v <= max, `int(${min},${max}) produced ${v}`);
    seen.add(v);
  }
  for (let v = min; v <= max; v++) assert.ok(seen.has(v), `int(${min},${max}) never produced ${v} over 20000 draws`);
});

test('bool() — both outcomes occur and nothing else does', () => {
  const rng = new Rng(55);
  let trues = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const v = rng.bool();
    assert.equal(typeof v, 'boolean');
    if (v) trues++;
  }
  assert.ok(trues > 0 && trues < n);
  // loose balance check, not a strict distribution test
  assert.ok(Math.abs(trues / n - 0.5) < 0.05);
});

test('range(a, b) never leaves [a, b)', () => {
  const rng = new Rng(314);
  const min = -2.5;
  const max = 10.25;
  for (let i = 0; i < 50000; i++) {
    const v = rng.range(min, max);
    assert.ok(v >= min && v < max, `range(${min},${max}) produced ${v}`);
  }
});

test('pick(array) covers every index', () => {
  const rng = new Rng(2024);
  const arr = ['a', 'b', 'c', 'd', 'e', 'f'];
  const seen = new Set();
  for (let i = 0; i < 20000; i++) seen.add(rng.pick(arr));
  for (const el of arr) assert.ok(seen.has(el), `pick() never produced '${el}' over 20000 draws`);
});

test('gauss() is centred near zero with unit-ish spread', () => {
  // Not a rigorous normality test — just a sanity check that gauss() is
  // producing a real bell-shaped draw and not, say, a uniform one mislabeled.
  const rng = new Rng(11);
  const n = 200000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = rng.gauss();
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const variance = sumSq / n - mean * mean;
  assert.ok(Math.abs(mean) < 0.02, `mean ${mean} too far from 0`);
  assert.ok(Math.abs(variance - 1) < 0.05, `variance ${variance} too far from 1`);
});

test('disc(radius) — every point lies within the disc', () => {
  const rng = new Rng(4242);
  const radius = 6.0;
  for (let i = 0; i < 50000; i++) {
    const p = rng.disc(radius);
    const d = Math.hypot(p.x, p.z);
    assert.ok(d <= radius + 1e-9, `disc(${radius}) produced a point at distance ${d}`);
  }
});

test('disc(radius) — uniform BY AREA, not by radius: ~1/4 of points fall within r/2', () => {
  // If distance were sampled as `radius * next()` (uniform by radius)
  // instead of `radius * sqrt(next())` (uniform by area), points would
  // cluster near the centre and the inner-half-radius share would land near
  // 1/2, not 1/4 — this is exactly the bug ARCHITECTURE.md/mapgen.mjs is
  // guarding against.
  //
  // Tolerance: for p=0.25 and n=200000, the binomial standard deviation of
  // the observed fraction is sqrt(p(1-p)/n) ≈ 0.00097. A ±0.01 tolerance is
  // ~10 standard deviations, so a correctly-uniform generator fails this
  // by chance with probability far below floating-point noise; it is only
  // ever tripped by an actual radius-vs-area bug.
  const rng = new Rng(4242);
  const radius = 6.0;
  const n = 200000;
  let insideHalf = 0;
  for (let i = 0; i < n; i++) {
    const p = rng.disc(radius);
    if (Math.hypot(p.x, p.z) <= radius / 2) insideHalf++;
  }
  const frac = insideHalf / n;
  assert.ok(Math.abs(frac - 0.25) < 0.01, `expected ~0.25 of points within r/2, got ${frac}`);
});

test('disc(radius, out) writes into and returns the given object, allocating nothing new', () => {
  const rng = new Rng(1);
  const out = { x: 999, z: 999 };
  const returned = rng.disc(3.0, out);
  assert.equal(returned, out); // same reference, not a copy
  assert.ok(returned.x !== 999 || returned.z !== 999);
});

test('weighted(candidates, weights) — the two-parallel-arrays form converges to the given weights over 1e6 draws', () => {
  // Tolerance derived the same way as the disc() test: for the smallest
  // weight here (p=0.2, n=1e6) the binomial std is sqrt(0.2*0.8/1e6) ≈
  // 0.0004; ±0.01 is ~25 standard deviations of margin.
  const rng = new Rng(555);
  const candidates = ['low', 'mid', 'high'];
  const weights = [1, 3, 6]; // -> 0.1 / 0.3 / 0.6
  const n = 1_000_000;
  const counts = { low: 0, mid: 0, high: 0 };
  for (let i = 0; i < n; i++) counts[rng.weighted(candidates, weights)]++;
  assert.ok(Math.abs(counts.low / n - 0.1) < 0.01, `low: ${counts.low / n}`);
  assert.ok(Math.abs(counts.mid / n - 0.3) < 0.01, `mid: ${counts.mid / n}`);
  assert.ok(Math.abs(counts.high / n - 0.6) < 0.01, `high: ${counts.high / n}`);
});

test('weighted(table) — the single-object form converges to the given weights over 1e6 draws, and a zero weight never wins', () => {
  const rng = new Rng(777);
  const table = { a: 50, b: 30, c: 20, never: 0 };
  const n = 1_000_000;
  const counts = { a: 0, b: 0, c: 0, never: 0 };
  for (let i = 0; i < n; i++) counts[rng.weighted(table)]++;
  assert.ok(Math.abs(counts.a / n - 0.5) < 0.01, `a: ${counts.a / n}`);
  assert.ok(Math.abs(counts.b / n - 0.3) < 0.01, `b: ${counts.b / n}`);
  assert.ok(Math.abs(counts.c / n - 0.2) < 0.01, `c: ${counts.c / n}`);
  assert.equal(counts.never, 0);
});

test('weighted(entries) — the array-of-records form converges to each record\'s .weight over 1e6 draws, a zero weight never wins, and the record itself (not a key) comes back', () => {
  // Shape lifted straight from 04-items.md §12.3's treasure-class rows —
  // this is the form IMPLEMENTATION_PLAN.md §1 names as "weighted(entries)
  // для лут-таблиц". `resolveTC` needs `sub`, not just `kind`, so the whole
  // record has to survive the round trip, not just its weight.
  const rng = new Rng(2468013);
  const entries = [
    { kind: 'nodrop', weight: 620 },
    { kind: 'gold', weight: 230 },
    { kind: 'item', weight: 105 },
    { kind: 'potion', weight: 38, sub: 'tc_potion_2' },
    { kind: 'scroll', weight: 7, sub: 'tc_scroll' },
    { kind: 'never', weight: 0 },
  ];
  const n = 1_000_000;
  const counts = Object.fromEntries(entries.map((e) => [e.kind, 0]));
  for (let i = 0; i < n; i++) {
    const picked = rng.weighted(entries);
    // It's the actual record, not a copy and not a key.
    assert.ok(entries.includes(picked));
    counts[picked.kind]++;
  }
  assert.ok(Math.abs(counts.nodrop / n - 0.62) < 0.01, `nodrop: ${counts.nodrop / n}`);
  assert.ok(Math.abs(counts.gold / n - 0.23) < 0.01, `gold: ${counts.gold / n}`);
  assert.ok(Math.abs(counts.item / n - 0.105) < 0.01, `item: ${counts.item / n}`);
  assert.ok(Math.abs(counts.potion / n - 0.038) < 0.01, `potion: ${counts.potion / n}`);
  assert.ok(Math.abs(counts.scroll / n - 0.007) < 0.01, `scroll: ${counts.scroll / n}`);
  assert.equal(counts.never, 0);

  // `sub` survived on a record that actually got drawn.
  const rng2 = new Rng(1);
  let sawPotionSub = false;
  for (let i = 0; i < 2000 && !sawPotionSub; i++) {
    const picked = rng2.weighted(entries);
    if (picked.kind === 'potion') { assert.equal(picked.sub, 'tc_potion_2'); sawPotionSub = true; }
  }
  assert.ok(sawPotionSub, 'never drew the potion entry in 2000 tries to check .sub survived');
});

test('weighted() — all three forms are mutually consistent: same state + same weights pick the same index and consume exactly one draw', () => {
  // This is the determinism-contract requirement: 04-items.md §12.3's
  // twelve-step loot draw order counts each table lookup as ONE draw
  // (ARCHITECTURE.md § Determinism contract). If any form looped `next()`
  // per candidate instead of once, the three forms would desync the
  // stream relative to each other and this test would catch it.
  const weights = [2, 3, 5]; // -> 0.2 / 0.3 / 0.5, indices 0/1/2
  const labels = ['x', 'y', 'z'];
  const entries = labels.map((label, i) => ({ label, weight: weights[i] }));
  const table = { x: 2, y: 3, z: 5 };

  const seed = 424242;
  for (let trial = 0; trial < 500; trial++) {
    // Fresh, identically-seeded (but distinct) instances per trial so each
    // trial exercises a different point in the stream, not just seed state.
    const rngArr = new Rng(seed);
    const rngEnt = new Rng(seed);
    const rngTbl = new Rng(seed);
    // Advance all three identically first, so later trials aren't just t=0.
    for (let i = 0; i < trial; i++) { rngArr.next(); rngEnt.next(); rngTbl.next(); }

    const beforeArr = [rngArr.s0, rngArr.s1, rngArr.s2, rngArr.s3];

    const pickedArr = rngArr.weighted(labels, weights);
    const pickedEnt = rngEnt.weighted(entries);
    const pickedTbl = rngTbl.weighted(table);

    const idx = labels.indexOf(pickedArr);
    assert.equal(entries[idx].label, pickedEnt.label, `trial ${trial}: entries form disagreed with array form`);
    assert.equal(labels[idx], pickedTbl, `trial ${trial}: table form disagreed with array form`);

    // All three consumed exactly one draw: their resulting state is
    // identical to each other, and different from the pre-draw state
    // (unless the single u32() call happened to be a no-op fixed point,
    // which xoshiro128** never has for a non-degenerate state).
    assert.deepEqual([rngArr.s0, rngArr.s1, rngArr.s2, rngArr.s3], [rngEnt.s0, rngEnt.s1, rngEnt.s2, rngEnt.s3]);
    assert.deepEqual([rngArr.s0, rngArr.s1, rngArr.s2, rngArr.s3], [rngTbl.s0, rngTbl.s1, rngTbl.s2, rngTbl.s3]);
    assert.notDeepEqual([rngArr.s0, rngArr.s1, rngArr.s2, rngArr.s3], beforeArr);
  }
});

test('weighted(entries) — edge cases: empty array and all-zero weights both throw before consuming a draw; a single entry always wins', () => {
  const rngEmpty = new Rng(1);
  const stateBefore = [rngEmpty.s0, rngEmpty.s1, rngEmpty.s2, rngEmpty.s3];
  assert.throws(() => rngEmpty.weighted([]));
  // No draw was consumed by the failed call — state is untouched.
  assert.deepEqual([rngEmpty.s0, rngEmpty.s1, rngEmpty.s2, rngEmpty.s3], stateBefore);

  const rngZero = new Rng(2);
  const zeroStateBefore = [rngZero.s0, rngZero.s1, rngZero.s2, rngZero.s3];
  assert.throws(() => rngZero.weighted([{ kind: 'a', weight: 0 }, { kind: 'b', weight: 0 }]));
  assert.deepEqual([rngZero.s0, rngZero.s1, rngZero.s2, rngZero.s3], zeroStateBefore);

  // A single positive-weight entry is always returned, regardless of the
  // draw — there's only one possible answer.
  const rngOne = new Rng(3);
  const only = { kind: 'solo', weight: 17 };
  for (let i = 0; i < 100; i++) assert.equal(rngOne.weighted([only]), only);
});

test('weighted(candidates, weights) and weighted(table) — the same empty/all-zero guard applies to the other two forms', () => {
  assert.throws(() => new Rng(1).weighted([], []));
  assert.throws(() => new Rng(1).weighted(['a', 'b'], [0, 0]));
  assert.throws(() => new Rng(1).weighted({}));
  assert.throws(() => new Rng(1).weighted({ a: 0, b: 0 }));
});

test('fork() — two forks from the same parent state produce different streams', () => {
  const parent = new Rng(999);
  const childA = parent.fork();
  const childB = parent.fork();
  const seqA = [childA.u32(), childA.u32(), childA.u32(), childA.u32()];
  const seqB = [childB.u32(), childB.u32(), childB.u32(), childB.u32()];
  assert.notDeepEqual(seqA, seqB);
});

test('fork() — a child never repeats the parent\'s own stream', () => {
  const parent = new Rng(31337);
  const child = parent.fork(); // consumes 4 words off `parent`
  const childSeq = [child.u32(), child.u32(), child.u32(), child.u32()];
  const parentSeq = [parent.u32(), parent.u32(), parent.u32(), parent.u32()];
  assert.notDeepEqual(childSeq, parentSeq);
});

test('fork() is deterministic: the same parent, in the same state, forks an identical child', () => {
  const parent1 = new Rng(2468);
  const child1 = parent1.fork();

  const parent2 = new Rng(2468);
  const child2 = parent2.fork();

  for (let i = 0; i < 50; i++) assert.equal(child1.u32(), child2.u32());
});

test('fork() advances the parent stream, so a second fork() from the same instance is not the first one replayed', () => {
  const parent = new Rng(2468);
  const child1 = parent.fork();
  const child2 = parent.fork();
  assert.notEqual(child1.s0, child2.s0);
});
