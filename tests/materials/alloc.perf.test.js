// tests/materials/alloc.perf.test.js
//
// MATL-1 allocation-free acceptance tests — `paletteFor`/`rarityColour`/
// `release`/`atlas` are all `Alloc = no` per docs/spec/02-api-contracts.md
// §2. Any test asserting an allocation goes in a `*.perf.test.js` file so
// `npm run test:perf` isolates it (`--test-concurrency=1`, per this
// project's own `package.json` — O-85: an allocation assert flakes under
// concurrency, never fixed by retry/loosening, only by isolation).
//
// Uses `tests/helpers/alloc.js`'s `assertAllocationFree` — the shared
// sampling protocol every other `A`-set gate in this repo already uses
// (O-23/O-43: real per-call floor is ~23 B/call and never dips below it, so
// the spec's own `< 1 byte/call` threshold stays meaningful without being
// loosened). Requires `node --expose-gc` (this repo's `test:perf` script
// already passes it); every test here `t.skip()`s itself when `global.gc`
// is absent, per that helper's own header.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MaterialsSystem } from '../../src/materials/index.js';
import { hasGc, assertAllocationFree } from '../helpers/alloc.js';

function makeBareCtx() {
  return { get: () => null, rng: null, events: { on() {}, emit() {} } };
}

// NOTE on `sink` below: `sink += c.r` (accumulating the FLOAT colour
// channel itself) reads as a false-positive ~16 B/call on this machine's
// Node — not a real allocation in `rarityColour()`, confirmed by bisection:
// the box is V8 heap-allocating the accumulated double, an artifact of
// *this test's own* accumulation shape, identical to O-23/O-43's "distinguish
// a real leak by watching total bytes, not the mean" warning, just one step
// upstream of it. A comparison-based side effect (`sink++` on a boundless
// integer counter) still proves `fn` actually ran without ever needing to
// store a float, so it cannot mask a real per-call allocation the way a
// loosened threshold would.

test('rarityColour(rarity): allocation-free with no out (returns a pre-built shared scratch)', async (t) => {
  if (!hasGc()) { t.skip('needs `node --expose-gc`'); return; }
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  let sink = 0;
  const rarities = ['normal', 'superior', 'magic', 'rare', 'unique'];
  let i = 0;
  const fn = () => {
    const c = sys.rarityColour(rarities[i % rarities.length]);
    if (c.r >= 0) sink++;
    i++;
  };
  const result = assertAllocationFree(fn, { iterations: 20_000, maxRounds: 300 });
  assert.ok(result.bytesPerCall < 1);
  assert.ok(sink > 0);
});

test('rarityColour(rarity, out): allocation-free with a caller-supplied out', async (t) => {
  if (!hasGc()) { t.skip('needs `node --expose-gc`'); return; }
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const out = { r: 0, g: 0, b: 0 }; // built OUTSIDE fn, per rule 5
  let sink = 0;
  const fn = () => {
    sys.rarityColour('magic', out);
    if (out.r >= 0) sink++;
  };
  const result = assertAllocationFree(fn, { iterations: 20_000, maxRounds: 300 });
  assert.ok(result.bytesPerCall < 1);
  assert.ok(sink > 0);
});

test('paletteFor(zoneId): allocation-free — returns the precomputed Palette', async (t) => {
  if (!hasGc()) { t.skip('needs `node --expose-gc`'); return; }
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  const zones = ['last_bastion', 'ashen_wastes', 'bonereach', 'altar_of_instruction', 'unknown_zone'];
  let sink = 0;
  let i = 0;
  const fn = () => {
    const p = sys.paletteFor(zones[i % zones.length]);
    sink += p.zoneId.length;
    i++;
  };
  const result = assertAllocationFree(fn, { iterations: 20_000, maxRounds: 300 });
  assert.ok(result.bytesPerCall < 1);
  assert.ok(sink > 0);
});

test('release(key): allocation-free, including the unknown-key miss path', async (t) => {
  if (!hasGc()) { t.skip('needs `node --expose-gc`'); return; }
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  sys.get('stone_wall', { surface: 'stone', seed: 1 });
  const fn = () => { sys.release('stone_wall'); };
  const result = assertAllocationFree(fn, { iterations: 20_000, maxRounds: 300 });
  assert.ok(result.bytesPerCall < 1);
});

test('atlas(name): allocation-free once the name is already registered (steady state)', async (t) => {
  if (!hasGc()) { t.skip('needs `node --expose-gc`'); return; }
  const sys = new MaterialsSystem();
  await sys.init(makeBareCtx());
  sys.atlas('items').register('TEX', (id) => id); // one-time registration cost — see index.js's own atlas() header
  let sink = 0;
  const fn = () => {
    const a = sys.atlas('items');
    if (a.uvFor(1) >= 0) sink++;
  };
  const result = assertAllocationFree(fn, { iterations: 20_000, maxRounds: 300 });
  assert.ok(result.bytesPerCall < 1);
  assert.ok(sink > 0);
});

test('rarityColour/paletteFor never call Math.hypot (banned in Alloc=no methods per this ticket\'s brief)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../src/materials/index.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');
  assert.ok(!/Math\.hypot/.test(code), 'src/materials/index.js must not call Math.hypot');
});
