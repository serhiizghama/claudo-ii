// tests/core/config.test.js
//
// CORE-6 acceptance tests for src/core/config.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6).
//
// Literal preset values are checked against the tables cited in
// src/core/config.js's header (docs/spec/08-characters-visual.md §9.6,
// docs/spec/01-data-model.md §11.1, docs/spec/10-audio.md §8.5) so a
// transposed column or a copy-paste slip fails loudly rather than just
// "some number exists".

import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfig, QUALITY_PRESETS } from '../../src/core/config.js';

const BUDGET_KEYS = ['maxActors', 'groundItemBudget', 'particleBudget', 'decalBudget', 'shadowMapSize'];
const NUMERIC_KEYS = ['maxActors', 'maxSkinned', 'corpseBudget', 'groundItemBudget', 'particleBudget', 'decalBudget', 'shadowMapSize'];
const PRESET_NAMES = ['low', 'medium', 'high', 'ultra'];

// docs/spec/08-characters-visual.md §9.6 + docs/spec/01-data-model.md §11.1 +
// docs/spec/10-audio.md §8.5, exactly as handed down for this ticket.
const EXPECTED = {
  low: {
    maxActors: 24, maxSkinned: 14, corpseBudget: 6,
    groundItemBudget: 48, particleBudget: 2000, decalBudget: 64, shadowMapSize: 1024,
    audio: { emitters: 24, drySlots: 12, convolvers: 1, altarIR: 1.8, musicPerc: false, grains: 0.5 },
  },
  medium: {
    maxActors: 32, maxSkinned: 20, corpseBudget: 10,
    groundItemBudget: 96, particleBudget: 6000, decalBudget: 128, shadowMapSize: 2048,
    audio: { emitters: 32, drySlots: 16, convolvers: 1, altarIR: 2.4, musicPerc: true, grains: 0.75 },
  },
  high: {
    maxActors: 44, maxSkinned: 26, corpseBudget: 16,
    groundItemBudget: 160, particleBudget: 12000, decalBudget: 256, shadowMapSize: 2048,
    audio: { emitters: 48, drySlots: 16, convolvers: 2, altarIR: 3.2, musicPerc: true, grains: 1.0 },
  },
  ultra: {
    maxActors: 56, maxSkinned: 32, corpseBudget: 20,
    groundItemBudget: 256, particleBudget: 24000, decalBudget: 512, shadowMapSize: 4096,
    audio: { emitters: 64, drySlots: 24, convolvers: 2, altarIR: 3.2, musicPerc: true, grains: 1.5 },
  },
};

test('module imports and createConfig() works in Node without window/location', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(typeof location, 'undefined');
  const config = createConfig();
  assert.equal(config.quality, 'high');
});

test('all four presets exist and carry every acceptance-criterion key', () => {
  for (const name of PRESET_NAMES) {
    const preset = QUALITY_PRESETS[name];
    assert.ok(preset, `missing preset "${name}"`);
    for (const key of BUDGET_KEYS) {
      assert.ok(key in preset, `preset "${name}" is missing "${key}"`);
    }
  }
});

test('preset values match the spec tables literally, key by key', () => {
  for (const name of PRESET_NAMES) {
    const preset = QUALITY_PRESETS[name];
    const expected = EXPECTED[name];
    for (const key of NUMERIC_KEYS) {
      assert.equal(preset[key], expected[key], `${name}.${key}`);
    }
    assert.deepEqual(preset.audio, expected.audio, `${name}.audio`);
  }
});

test('budgets are monotonic low <= medium <= high <= ultra, per numeric key', () => {
  for (const key of NUMERIC_KEYS) {
    const values = PRESET_NAMES.map((name) => QUALITY_PRESETS[name][key]);
    for (let i = 1; i < values.length; i++) {
      assert.ok(
        values[i - 1] <= values[i],
        `${key}: ${PRESET_NAMES[i - 1]}=${values[i - 1]} > ${PRESET_NAMES[i]}=${values[i]}`
      );
    }
  }
});

test('maxSkinned never exceeds maxActors in any preset', () => {
  for (const name of PRESET_NAMES) {
    const preset = QUALITY_PRESETS[name];
    assert.ok(preset.maxSkinned <= preset.maxActors, `${name}: maxSkinned > maxActors`);
  }
});

test('default quality is "high" (no quality given, no ?q param)', () => {
  const config = createConfig();
  assert.equal(config.quality, 'high');
  assert.equal(config.q, QUALITY_PRESETS.high);
});

test('explicit quality selects the matching preset', () => {
  for (const name of PRESET_NAMES) {
    const config = createConfig({ quality: name });
    assert.equal(config.quality, name);
    assert.equal(config.q, QUALITY_PRESETS[name]);
  }
});

test('unknown quality preset name throws a clear error rather than silently substituting one', () => {
  assert.throws(() => createConfig({ quality: 'potato' }), /unknown quality preset/i);
});

test('camPitch === 52, camDist === 22, stamina === false', () => {
  const config = createConfig();
  assert.equal(config.camPitch, 52);
  assert.equal(config.camDist, 22);
  assert.equal(config.stamina, false);
});

test('deterministic defaults to false and is settable explicitly', () => {
  assert.equal(createConfig().deterministic, false);
  assert.equal(createConfig({ deterministic: true }).deterministic, true);
  assert.equal(createConfig({ deterministic: false }).deterministic, false);
});

test('lockstep and prewarm carry sane Node defaults (no URL to read)', () => {
  const config = createConfig();
  assert.equal(config.lockstep, false);
  assert.equal(config.prewarm, true);
});

test('seed is undefined by default (no ?seed to read, no override given)', () => {
  assert.equal(createConfig().seed, undefined);
});

test('each preset object is frozen — a write attempt does not mutate a budget', () => {
  for (const name of PRESET_NAMES) {
    const preset = QUALITY_PRESETS[name];
    assert.ok(Object.isFrozen(preset), `${name} preset is not frozen`);
    assert.ok(Object.isFrozen(preset.audio), `${name}.audio is not frozen`);

    const before = preset.maxActors;
    // ES modules are strict by default, so writing to a frozen object
    // throws TypeError here rather than silently failing.
    assert.throws(() => {
      preset.maxActors = 999999;
    }, TypeError);
    assert.equal(preset.maxActors, before);
  }
});

test('createConfig() returns a fresh object each call — callers cannot corrupt a shared instance', () => {
  const a = createConfig();
  const b = createConfig();
  assert.notEqual(a, b);
  assert.equal(a.q, b.q); // the preset itself is shared and frozen, that's fine
});
