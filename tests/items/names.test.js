// tests/items/names.test.js
//
// ITEM-8 acceptance tests for `src/items/data/names.js` (the pools) and
// `src/items/names.js` (the composer + the 64-entry recent-name ring).
// `node:test` + `node:assert/strict` only, matching every sibling test file
// in this repo.
//
// THIS FILE'S ACCEPTANCE GATE (this ticket's brief, six clauses):
//   1. Pools are 13 §10.5's 56 heads / 48 tails, index-aligned, with `g` on
//      every head and `def` on exactly the tails the table marks ✔.
//   2. The draws are Ui(0,55) then Ui(0,47), at D13, two draws — proven with
//      a scripted/counting Rng, not by reading the source.
//   3. The 64-entry ring yields zero repeats in any 64-consecutive-rare
//      window — hard fail, proven over a long real-Rng-driven run.
//   4. Every rare name is exactly two components (one head, one tail) — the
//      structural invariant, not an English token count.
//   5. 100 000 rares produce no `undefined`/empty word, in both languages.
//   6. The ring is allocation-free (see tests/items/names.perf.test.js for
//      the measured proof; this file only checks the *behavioural*
//      contract — no Map/Set is used, verified here structurally by
//      driving the ring through far more than 64 codes and confirming it
//      never grows past 64 live entries' worth of information).
//
// PROGRESS D-25 (binding, `13-progression-lore.md` §10.3/§10.5) supersedes
// `04-items.md` §3.2-§3.5 wholesale — none of `04`'s 44/48/20 pools or its
// three-word `affixCount >= 5` branch are exercised or expected anywhere in
// this file. See `src/items/names.js`'s own header for the full ruling.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Rng } from '../../src/core/rng.js';
import { CountingRng } from '../../src/items/rng.js';
import { RARE_HEAD, RARE_TAIL } from '../../src/items/data/names.js';
import { rollRareName, composeRareName, resetRareRing, __ring } from '../../src/items/names.js';

test('ITMS.N00 loads headless in plain Node with no browser globals', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof rollRareName, 'function');
});

// ---------------------------------------------------------------------------
// A scripted Rng, same technique tests/items/roll.test.js's own R21-R24 use:
// `Rng.int(min,max)` is `min + floor(next() * (max-min+1))`, so scripting
// `next()` values controls exactly which index `int()` returns.
// ---------------------------------------------------------------------------
class ScriptedRng extends Rng {
  constructor(script) {
    super(1); // dummy seed — next() is overridden below, real state unused
    this._script = script.slice();
    this.log = [];
  }
  next() {
    const v = this._script.length ? this._script.shift() : 0.999999;
    this.log.push(v);
    return v;
  }
}

/** The `next()` value that makes `Rng.int(0, count-1)` return `idx`. */
function nextFor(idx, count) {
  return (idx + 0.5) / count;
}

// ---------------------------------------------------------------------------
// 1. Pool shape — 56 heads / 48 tails, `g` on every head, `def` exactly on
//    the ✔ tails.
// ---------------------------------------------------------------------------

test('ITMS.N01 RARE_HEAD has exactly 56 entries, every one frozen with a valid en/ru/g', () => {
  assert.equal(RARE_HEAD.length, 56);
  assert.ok(Object.isFrozen(RARE_HEAD));
  const validGenders = new Set(['m', 'f', 'n', 'p']);
  for (let i = 0; i < RARE_HEAD.length; i++) {
    const h = RARE_HEAD[i];
    assert.ok(Object.isFrozen(h), `head ${i} must be frozen`);
    assert.equal(typeof h.en, 'string');
    assert.ok(h.en.length > 0, `head ${i} en must be non-empty`);
    assert.equal(typeof h.ru, 'string');
    assert.ok(h.ru.length > 0, `head ${i} ru must be non-empty`);
    assert.ok(validGenders.has(h.g), `head ${i} gender tag '${h.g}' must be one of m/f/n/p`);
  }
});

test('ITMS.N02 RARE_TAIL has exactly 48 entries, every one frozen with a valid en/ru/def', () => {
  assert.equal(RARE_TAIL.length, 48);
  assert.ok(Object.isFrozen(RARE_TAIL));
  for (let i = 0; i < RARE_TAIL.length; i++) {
    const t = RARE_TAIL[i];
    assert.ok(Object.isFrozen(t), `tail ${i} must be frozen`);
    assert.equal(typeof t.en, 'string');
    assert.ok(t.en.length > 0, `tail ${i} en must be non-empty`);
    assert.equal(typeof t.ru, 'string');
    assert.ok(t.ru.length > 0, `tail ${i} ru must be non-empty`);
    assert.equal(typeof t.def, 'boolean', `tail ${i} def must be a boolean`);
  }
});

test('ITMS.N03 RARE_TAIL.def is true on exactly the 24 tails 13 §10.5 marks ✔ (0-indexed)', () => {
  // 13 §10.5's 1-indexed ✔ rows: 10-23, 32-38, 46-48 (24 total). Ruling B's
  // prose loosely says "tails 10 to 23 and 32 to 48", but the table itself
  // (ground truth) does NOT mark 39-45 — those five (Iron/Salt/Glass/Cold/
  // Smoke/Rot/Bile, actually seven: 39-45) are plain genitive nouns with no
  // "of the" reading. Transcribed from the table, not the summary.
  const expectedDefOneIndexed = [
    10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    32, 33, 34, 35, 36, 37, 38,
    46, 47, 48,
  ];
  const expectedDefSet = new Set(expectedDefOneIndexed.map((n) => n - 1));
  assert.equal(expectedDefOneIndexed.length, 24);
  for (let i = 0; i < RARE_TAIL.length; i++) {
    assert.equal(RARE_TAIL[i].def, expectedDefSet.has(i), `tail index ${i} (1-indexed #${i + 1}, en="${RARE_TAIL[i].en}") def flag mismatch`);
  }
});

// ---------------------------------------------------------------------------
// 4. Composition — the three worked examples from 13 §10.5, verbatim, plus
//    the structural N1 invariant over the full 2688-combination space.
// ---------------------------------------------------------------------------

test('ITMS.N04 composeRareName: the three worked examples from 13 §10.5, verbatim', () => {
  // head 7 + tail 1 -> Doom Ash / Погибель Праха (1-indexed in the spec)
  assert.deepEqual(composeRareName(6, 0), { en: 'Doom Ash', ru: 'Погибель Праха' });
  // head 12 + tail 10 -> Fang of the Instructor / Клык Наставника
  assert.deepEqual(composeRareName(11, 9), { en: 'Fang of the Instructor', ru: 'Клык Наставника' });
  // head 5 + tail 34 -> Word of the First Lesson / Слово Первого урока
  assert.deepEqual(composeRareName(4, 33), { en: 'Word of the First Lesson', ru: 'Слово Первого урока' });
});

test('ITMS.N05 (N1) every one of the 2688 (head,tail) combinations is exactly two components, structurally', () => {
  // "Exactly two components" = one valid head index (0..55) + one valid
  // tail index (0..47); assert the STRUCTURE, not an English token count
  // (Ruling B: the English "of" makes a def tail four space-separated
  // tokens, e.g. "Fang of the Instructor").
  //
  // Russian: also asserted structurally (name === head.ru + ' ' + tail.ru),
  // NOT by a fixed token count. 13 §10.5's own worked example ("Слово
  // Первого урока") is itself three RU tokens because tails #33/#34/#38 are
  // authored as two-word genitive phrases ("Последнего часа", "Первого
  // урока", "Долгой дороги") — Ruling B's "exactly two space-separated
  // words in Russian" is a loose paraphrase contradicted by the table's own
  // worked example; the table (and the worked example beneath it) wins,
  // same precedent as ITMS.N03 above.
  let checked = 0;
  for (let h = 0; h < RARE_HEAD.length; h++) {
    for (let t = 0; t < RARE_TAIL.length; t++) {
      const head = RARE_HEAD[h];
      const tail = RARE_TAIL[t];
      const { en, ru } = composeRareName(h, t);
      const expectedEn = tail.def ? `${head.en} of ${tail.en}` : `${head.en} ${tail.en}`;
      const expectedRu = `${head.ru} ${tail.ru}`;
      assert.equal(en, expectedEn, `head ${h} tail ${t}: en mismatch`);
      assert.equal(ru, expectedRu, `head ${h} tail ${t}: ru mismatch`);
      // RU always has at least the one separating space between head and
      // tail (a real two-component name), even when a component itself
      // contains an internal space.
      assert.ok(ru.includes(' '), `head ${h} tail ${t}: ru "${ru}" must contain a space`);
      checked++;
    }
  }
  assert.equal(checked, 56 * 48);
});

// ---------------------------------------------------------------------------
// 2. D13 draw order and count — Ui(0,55) then Ui(0,47), 2/4/6/8 draws.
// ---------------------------------------------------------------------------

test('ITMS.N06 rollRareName with no ring collision consumes exactly 2 draws: Ui(0,55) then Ui(0,47)', () => {
  resetRareRing();
  const rng = new CountingRng(new Rng(0xc0ffee));
  const before = rng.draws;
  const result = rollRareName(rng);
  const consumed = rng.draws - before;
  assert.equal(consumed, 2, `expected exactly 2 draws with no collision, got ${consumed}`);
  assert.ok(result.headIndex >= 0 && result.headIndex <= 55);
  assert.ok(result.tailIndex >= 0 && result.tailIndex <= 47);
  assert.equal(result.code, result.headIndex * 48 + result.tailIndex);
});

test('ITMS.N07 rollRareName draws Ui(0,55) then Ui(0,47) in that order (scripted)', () => {
  resetRareRing();
  // Script: head index 12 (0-indexed) then tail index 30 (0-indexed) —
  // arbitrary, mid-range values that would be out of bounds for the
  // SUPERSEDED 44/48 pools, proving these are the D-25 ranges, not 04 §3's.
  const script = [nextFor(12, 56), nextFor(30, 48)];
  const rng = new ScriptedRng(script);
  const result = rollRareName(rng);
  assert.equal(result.headIndex, 12);
  assert.equal(result.tailIndex, 30);
  assert.equal(rng.log.length, 2, 'exactly two next() calls, none wasted on a third "epithet" draw');
});

test('ITMS.N08 rollRareName redraws on a ring collision: 2 extra draws per redraw, capped at 8', () => {
  resetRareRing();
  // Prime the ring with code (head=3, tail=3) = 3*48+3 = 147.
  const primeScript = [nextFor(3, 56), nextFor(3, 48)];
  rollRareName(new ScriptedRng(primeScript));

  // Now script a draw that collides with that code on the FIRST try, then
  // succeeds on the redraw (head=3,tail=3 again, then head=5,tail=5 which
  // is NOT in the ring) — this must consume 4 draws (2 + one redraw's 2).
  const oneRedrawScript = [
    nextFor(3, 56), nextFor(3, 48), // initial draw: collides (code 147)
    nextFor(5, 56), nextFor(5, 48), // redraw 1: code 5*48+5=245, not in ring
  ];
  const rng1 = new ScriptedRng(oneRedrawScript);
  const before1 = rng1.log.length;
  const result1 = rollRareName(rng1);
  assert.equal(rng1.log.length - before1, 4, 'one collision + one clean redraw must consume exactly 4 draws');
  assert.equal(result1.headIndex, 5);
  assert.equal(result1.tailIndex, 5);

  // Force the worst case: every one of the initial draw + all 3 redraws
  // collides with something already in the ring (147 from the prime call,
  // 245 from result1 above), by scripting FOUR colliding codes in a row,
  // then the loop gives up after tries reaches 3 (8 draws total) and keeps
  // whatever the 4th (last) draw was, collision or not.
  rollRareName(new ScriptedRng([nextFor(8, 56), nextFor(8, 48)])); // primes code 392 into the ring
  const worstScript = [
    nextFor(3, 56), nextFor(3, 48), // initial: 147, collides
    nextFor(5, 56), nextFor(5, 48), // redraw 1: 245, collides
    nextFor(8, 56), nextFor(8, 48), // redraw 2: 392, collides
    nextFor(9, 56), nextFor(9, 48), // redraw 3: 9*48+9=441, NOT in ring — but
    // the loop has already exited by the time this is evaluated as a
    // fourth check, so this is accepted regardless of collision.
  ];
  const rng2 = new ScriptedRng(worstScript);
  const result2 = rollRareName(rng2);
  assert.equal(rng2.log.length, 8, 'three collisions + the mandatory third redraw must consume exactly 8 draws (the cap)');
  assert.equal(result2.headIndex, 9);
  assert.equal(result2.tailIndex, 9);
});

// ---------------------------------------------------------------------------
// 3. The hard invariant — zero repeats in any 64-consecutive-rare window,
//    over a long real-Rng-driven run.
// ---------------------------------------------------------------------------

test('ITMS.N09 (hard fail) zero (head,tail) repeats in any 64-consecutive-rare window over a long run', () => {
  resetRareRing();
  const N = 100000;
  const rng = new Rng(0x51de51de);
  const codes = new Array(N);
  for (let i = 0; i < N; i++) codes[i] = rollRareName(rng).code;

  let violations = 0;
  const window = new Set();
  const queue = [];
  for (let i = 0; i < N; i++) {
    const code = codes[i];
    if (window.has(code)) {
      violations++;
    } else {
      window.add(code);
    }
    queue.push(code);
    if (queue.length > 64) {
      window.delete(queue.shift());
    }
  }
  assert.equal(violations, 0, `expected zero repeats in any 64-window over ${N} rares; found ${violations}`);
});

// ---------------------------------------------------------------------------
// Statistical bound (secondary guard, D-25's recomputation) — NOT the hard
// invariant above; a separate, looser sanity check on the full-sequence
// repeat rate (unbounded distance, not just within a 64-window).
// ---------------------------------------------------------------------------

test('ITMS.N10 (statistical) P(>=1 repeat anywhere in 100 draws) stays under the 35-40% sane ceiling', () => {
  const trials = 4000;
  const drawsPerTrial = 100;
  const rng = new Rng(0xfeedface);
  let trialsWithRepeat = 0;
  for (let trial = 0; trial < trials; trial++) {
    resetRareRing();
    const seen = new Set();
    let repeated = false;
    for (let i = 0; i < drawsPerTrial; i++) {
      const code = rollRareName(rng).code;
      if (seen.has(code)) repeated = true;
      seen.add(code);
    }
    if (repeated) trialsWithRepeat++;
  }
  const rate = trialsWithRepeat / trials;
  console.log(`  N10: P(>=1 repeat in 100 draws) ~= ${(rate * 100).toFixed(2)}% over ${trials} trials (D-25 expects ~21.9%)`);
  assert.ok(rate < 0.40, `repeat rate ${(rate * 100).toFixed(2)}% must stay under the 40% sane ceiling`);
});

// ---------------------------------------------------------------------------
// 5. 100 000 rares, no undefined / empty word, in both languages.
// ---------------------------------------------------------------------------

test('ITMS.N11 100000 rares produce no undefined and no empty word, in both languages', () => {
  resetRareRing();
  const rng = new Rng(0x00d5000d);
  for (let i = 0; i < 100000; i++) {
    const { en, ru, headIndex, tailIndex } = rollRareName(rng);
    assert.equal(typeof en, 'string', `rare ${i}: en must be a string`);
    assert.equal(typeof ru, 'string', `rare ${i}: ru must be a string`);
    assert.ok(en.length > 0 && !en.includes('undefined'), `rare ${i}: en "${en}" must be non-empty and not contain 'undefined'`);
    assert.ok(ru.length > 0 && !ru.includes('undefined'), `rare ${i}: ru "${ru}" must be non-empty and not contain 'undefined'`);
    assert.ok(headIndex >= 0 && headIndex <= 55, `rare ${i}: headIndex ${headIndex} out of range`);
    assert.ok(tailIndex >= 0 && tailIndex <= 47, `rare ${i}: tailIndex ${tailIndex} out of range`);
  }
});

// ---------------------------------------------------------------------------
// 6. The ring's shape — no Map/Set, fixed Int32Array(64), never grown.
// ---------------------------------------------------------------------------

test('ITMS.N12 the ring never grows past 64 live codes worth of information (Int32Array(64), not a Map/Set)', () => {
  resetRareRing();
  assert.equal(__ring.size, 64);
  // Push 1000 distinct codes; the ring can only ever "remember" the most
  // recent 64 — pushing a 65th-from-the-end code must make the earliest
  // one forgettable (no longer reported as contained).
  for (let i = 0; i < 1000; i++) __ring.push(i);
  // 1000 pushes leave exactly the last 64 values, [936, 999], live.
  assert.equal(__ring.contains(999), true, 'the most recent code must be found');
  assert.equal(__ring.contains(936), true, 'the 64th-from-most-recent code must still be found');
  assert.equal(__ring.contains(935), false, 'the 65th-from-most-recent code must have been evicted');
});

test('ITMS.N13 resetRareRing clears the ring in place (no repeat-avoidance carried across a zone:enter)', () => {
  resetRareRing();
  __ring.push(555);
  assert.equal(__ring.contains(555), true);
  resetRareRing();
  assert.equal(__ring.contains(555), false, 'a reset ring must not still contain a pre-reset code');
});
