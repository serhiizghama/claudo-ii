// src/core/config.js
//
// CORE-6 — `createConfig()`, the four quality presets (`config.q`) and URL
// parameter parsing (`?q`, `?capture`, `?lockstep`, `?prewarm`, `?seed`).
//
// Scope (docs/spec/11-flows.md §1 B2): `main.js` calls
// `createConfig({ quality: params.q ?? 'high', deterministic: capture })` to
// build the config object handed to `new Engine({ canvas, config })` (B3).
// `config.q` is the active quality preset; every other subsystem reads it
// off `ctx.config.q` and must never exceed a budget
// (docs/ARCHITECTURE.md "ctx provides").
//
// Node-safe: no `three` import, no DOM access anywhere in this file. This
// module is imported headlessly by every harness (docs/spec/12-testing.md
// §2.1) and is checked by `tools/check-imports.mjs` (TEST-2) — `window` and
// `location` are read defensively and the module must work with neither
// present.

/**
 * The four quality presets. Flat data tables, not derived numbers — a
 * balance/perf harness reads these directly and an interpolated value
 * (e.g. "low = high / 2") could not be checked against the spec it came
 * from. Every preset is deep-frozen below so no subsystem can mutate a
 * budget out from under its neighbours.
 *
 * Sources, one row per key:
 *   - maxActors, maxSkinned, corpseBudget:
 *     docs/spec/08-characters-visual.md §9.6 ("Exceeding the budget").
 *     `maxActors` here is the *simulated* actor cap (24/32/44/56) — not to
 *     be confused with the `Actor` record POOL size in
 *     docs/spec/01-data-model.md §11.1 (60/100/160/220), which is a
 *     separate number owned by `actors` (ticket ACTR-1). That table row
 *     is annotated "(q.maxActors)"; per the project owner that annotation
 *     is a spec typo and does not mean the pool size belongs in `config.q`.
 *   - groundItemBudget, particleBudget, decalBudget:
 *     docs/spec/01-data-model.md §11.1 ("The pools").
 *   - shadowMapSize: not specified by any of the thirteen `docs/spec/*.md`
 *     files (checked). Assigned by the project owner as a placeholder;
 *     owned by RNDR-4 (M8) and subject to revision once real frame timings
 *     exist.
 *   - audio: docs/spec/10-audio.md §8.5 ("Degradation ladder"), the
 *     "Quality presets (`config.q.audio`)" table — emitters/drySlots/
 *     convolvers/altarIR/musicPerc/grains per preset. Corroborated by the
 *     emitters+drySlots figures at 10-audio.md line ~550
 *     ("low 24 + 12, medium 32 + 16, high 48 + 16, ultra 64 + 24").
 */
const QUALITY_PRESETS = {
  low: {
    maxActors: 24,
    maxSkinned: 14,
    corpseBudget: 6,
    groundItemBudget: 48,
    particleBudget: 2000,
    decalBudget: 64,
    shadowMapSize: 1024,
    audio: {
      emitters: 24,
      drySlots: 12,
      convolvers: 1,
      altarIR: 1.8,
      musicPerc: false,
      grains: 0.5,
    },
  },
  medium: {
    maxActors: 32,
    maxSkinned: 20,
    corpseBudget: 10,
    groundItemBudget: 96,
    particleBudget: 6000,
    decalBudget: 128,
    shadowMapSize: 2048,
    audio: {
      emitters: 32,
      drySlots: 16,
      convolvers: 1,
      altarIR: 2.4,
      musicPerc: true,
      grains: 0.75,
    },
  },
  high: {
    maxActors: 44,
    maxSkinned: 26,
    corpseBudget: 16,
    groundItemBudget: 160,
    particleBudget: 12000,
    decalBudget: 256,
    shadowMapSize: 2048,
    audio: {
      emitters: 48,
      drySlots: 16,
      convolvers: 2,
      altarIR: 3.2,
      musicPerc: true,
      grains: 1.0,
    },
  },
  ultra: {
    maxActors: 56,
    maxSkinned: 32,
    corpseBudget: 20,
    groundItemBudget: 256,
    particleBudget: 24000,
    decalBudget: 512,
    shadowMapSize: 4096,
    audio: {
      emitters: 64,
      drySlots: 24,
      convolvers: 2,
      altarIR: 3.2,
      musicPerc: true,
      grains: 1.5,
    },
  },
};

const DEFAULT_QUALITY = 'high';

/** Deep-freezes a plain-object tree (objects and arrays only — every leaf
 * here is a number, string or boolean, so one recursive pass is enough). */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

for (const name of Object.keys(QUALITY_PRESETS)) deepFreeze(QUALITY_PRESETS[name]);

/**
 * Reads `location.search` if a browser-like `location` global exists;
 * returns an empty `URLSearchParams` otherwise. Never throws — this is the
 * one thing that makes the module safe to import from Node harnesses that
 * have neither `window` nor `location` (docs/spec/12-testing.md §2.1).
 * @returns {URLSearchParams}
 */
function readUrlParams() {
  if (typeof location === 'undefined' || typeof location.search !== 'string') {
    return new URLSearchParams();
  }
  return new URLSearchParams(location.search);
}

/**
 * Parses a URL flag param as a boolean. Absent → `undefined` (caller
 * decides the default). Present as `'0'` or `'false'` → `false`. Present as
 * anything else, including the bare `?flag` (empty string) → `true`.
 * @param {URLSearchParams} params
 * @param {string} key
 * @returns {boolean | undefined}
 */
function parseBoolParam(params, key) {
  if (!params.has(key)) return undefined;
  const raw = params.get(key);
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

/**
 * Parses `?seed` as a uint32. Absent or not a finite number → `undefined`
 * (no override; the one non-deterministic draw stays in `main.js`, per
 * docs/spec/11-flows.md §14.2 — this module only surfaces the override).
 * @param {URLSearchParams} params
 * @returns {number | undefined}
 */
function parseSeedParam(params) {
  if (!params.has('seed')) return undefined;
  const n = Number(params.get('seed'));
  if (!Number.isFinite(n)) return undefined;
  return n >>> 0;
}

/**
 * Builds the config object passed to `new Engine({ canvas, config })`
 * (docs/spec/11-flows.md §1 B2/B3).
 *
 * @param {object} [opts]
 * @param {'low'|'medium'|'high'|'ultra'} [opts.quality] - explicit preset
 *   name, overriding `?q`. Defaults to `?q` if present, else `'high'`
 *   (docs/IMPLEMENTATION_PLAN.md §0: desktop-only, 1080p/60 target).
 * @param {boolean} [opts.deterministic] - explicit harness-mode flag,
 *   overriding `?capture`. Defaults to `?capture`'s truthiness, else
 *   `false`.
 * @returns {object} the engine config.
 */
export function createConfig(opts = {}) {
  const params = readUrlParams();

  const quality = opts.quality ?? params.get('q') ?? DEFAULT_QUALITY;
  const preset = QUALITY_PRESETS[quality];
  if (preset === undefined) {
    const valid = Object.keys(QUALITY_PRESETS).join(', ');
    throw new Error(`createConfig: unknown quality preset "${quality}" (valid: ${valid})`);
  }

  const capture = parseBoolParam(params, 'capture');
  const deterministic = opts.deterministic ?? capture ?? false;

  const lockstep = parseBoolParam(params, 'lockstep') ?? false;
  // Defaults to running pre-warm; `?prewarm=0` opts a dev/perf session out
  // of it. `core/prewarm.js` (CORE-8, not owned by this ticket) is expected
  // to consult this flag before running `prewarmMaterials` on every
  // subsystem.
  const prewarm = parseBoolParam(params, 'prewarm') ?? true;
  const seed = parseSeedParam(params);

  return {
    quality,
    q: preset,

    // Camera rig constants (docs/spec/11-flows.md §1 B3): not part of `q`,
    // owned by this ticket only insofar as B2/B3 place them on `config`
    // itself. FOV belongs to the camera (RNDR-2), not here.
    camPitch: 52,
    camDist: 22,

    // Harness / boot flags read from the URL (§1 B2). `deterministic` is
    // the `?capture` flag under its engine-facing name: a harness run that
    // must reproduce bit-for-bit needs a fixed seed, no HMR, and no
    // wall-clock-seeded randomness anywhere downstream — this module does
    // not itself draw the seed (docs/spec/11-flows.md §14.2 keeps the one
    // non-deterministic `Math.random()` call in `main.js`, outside every
    // subsystem); it only carries the flag and an optional `?seed`
    // override for whoever does.
    deterministic,
    lockstep,
    prewarm,
    seed,

    // BACKLOG.md "Post-M9" — Stamina and sprint: "`config.stamina` defaults
    // to false". Not implemented pre-M9; the key exists so `player`/`ui`
    // can check it without an `undefined` special case.
    stamina: false,
  };
}

export { QUALITY_PRESETS };
