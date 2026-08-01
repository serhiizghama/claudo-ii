#!/usr/bin/env node
// tools/iconbench.mjs
//
// ITEM-15 — the icon acceptance/timing driver. Two things this ticket's
// criterion asks for that `node --test` cannot provide on its own:
//
//   1. Proof that all 305 equipment-base x rarity renders
//      (`04-items.md` §12 step 11: 61 equipment bases x 5 rarities) actually
//      happen and produce DISTINCT bitmaps — not just "didn't throw".
//   2. A p95/p100 timing measurement against the heaviest recipe
//      (`armour_sepulchre_elite`, `04` §11.2) against a real clock.
//
// ---------------------------------------------------------------------------
// Ruling D-24 — why this file exists outside `src/items/`, and how it times
// ---------------------------------------------------------------------------
// `src/items/` runs headless in bare Node (`tools/check-imports.mjs`'s N
// surface) and may not read `performance.now()` — but timing *something*
// requires a clock somewhere. D-24's resolution, spelled out in this
// ticket's own brief: "putting the timing outside the strict root ... Your
// timing driver is tools/iconbench.mjs. It runs the 305 calls in headless
// Chromium ... and times them with the page's OWN performance.now(), which
// the lint never scans because it only walks src/." That is exactly what
// this file does, following `tools/capture.mjs`'s own established shape
// (spawn `vite preview` over `dist/`, open headless Chromium at
// `?capture=1&lockstep=1`, wait for `window.__READY__`, then reach into the
// live `window.__ENGINE__.ctx` — no fresh `import()` of `src/`, same reason
// `capture.mjs`'s own header gives: a production build has no servable path
// back to unbundled source). `OffscreenCanvas` is real in that page (a
// desktop Chromium global, not worker-only), so `items.icon()`/
// `items.__iconGenerate()` run for real here — not the `null`-refusal path
// bare Node takes (see `src/items/icons/generate.js`'s header).
//
// Also true here, same as `capture.mjs`: never `npm run build`s for you —
// run it first, or this benchmarks stale code (see this project's own
// "two tooling traps" note).
//
// ---------------------------------------------------------------------------
// Two measurements, two different code paths, on purpose
// ---------------------------------------------------------------------------
// - The 305-render / distinctness pass calls the REAL, CACHED
//   `items.icon(item)` — the exact `02-api-contracts.md:1028` contract a
//   real caller uses. Each of the 305 (baseId, rarity) pairs is a distinct
//   cache key (`socketCount`/`superior` held constant), so every call is a
//   genuine cache MISS — this is real generation cost, not 305 memory reads.
// - The p95/p100 pass calls `items.__iconGenerate(base, opts)` — the
//   dev-only, non-cached raw generator `src/items/index.js` exposes for
//   exactly this (see that file's own comment on the hook, the same
//   `__archetypeVisuals`-precedent shape ACTR-6 already established) — 300
//   repeated generations of `armour_sepulchre_elite` at `rarity: 'unique'`
//   (the worst case: heaviest recipe x heaviest rarity-frame overlay, `04`
//   §11.2 / `09-ui.md` §7.4's `unique` row being the most overlay work of
//   the five). Repeated calls through the CACHED `icon()` would time a
//   property read after the first call, not the 1.2 ms generation budget.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_INDEX = join(REPO_ROOT, 'dist', 'index.html');
const DEFAULT_SEED_HEX = '0x5eed1234'; // src/main.js's own capture-mode constant
const VIEWPORT = { width: 1280, height: 720 };
// `--js-flags=--expose-gc` exposes a `gc()` global in the page — used ONLY
// to force a collection BETWEEN timed samples (never inside the measured
// window itself), so an incidental GC pause landing mid-sample cannot
// produce a spurious p100 outlier unrelated to the generation cost this
// budget is actually about. Each `generateIconCanvas` call allocates a
// fresh `OffscreenCanvas` (its own pixel buffer) plus several short-lived
// colour-math arrays (`Alloc: yes` is the contracted row —
// `02-api-contracts.md:1028` — this is not a zero-allocation path), so
// letting garbage from earlier samples accumulate across 300 repeats would
// make an unrelated GC pause a realistic, and misleading, contributor to
// the max.
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader', '--js-flags=--expose-gc'];

const P95_BUDGET_MS = 1.2;
const P100_BUDGET_MS = 2.0;
const HEAVY_BASE_ID = 'armour_sepulchre_elite';
const TIMING_SAMPLES = 300;
const TIMING_WARMUP = 20; // discarded — first-call JIT/shape warmup, not the steady-state cost this budget is about

function parseArgs(argv) {
  const args = { json: null, verbose: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--json') {
      const val = argv[i + 1];
      if (val === undefined) { args.error = '--json requires a path argument'; return args; }
      args.json = val; i++;
    } else { args.error = `unknown flag: ${a} (see --help)`; return args; }
  }
  return args;
}

const HELP_TEXT = `iconbench.mjs — ITEM-15 acceptance/timing driver for items.icon()

Usage:
  node tools/iconbench.mjs [--json <path>] [--verbose] [--help]

Runs the full 04-items.md §12 step 11 acceptance pass in headless Chromium
against the built dist/ bundle (run \`npm run build\` first — this tool never
builds for you):
  1. Calls items.icon() for all 61 equipment bases x 5 rarities (305 calls),
     asserts every one succeeds and every resulting bitmap hashes distinct.
  2. Calls items.__iconGenerate() ${TIMING_SAMPLES} times (plus ${TIMING_WARMUP} discarded
     warm-up calls) against armour_sepulchre_elite at rarity 'unique' (the
     heaviest recipe x the heaviest rarity overlay), timed with the page's
     own performance.now(), and reports p50/p95/p100.

Exit codes:
  0  305/305 rendered, all distinct, p95 <= ${P95_BUDGET_MS}ms and p100 <= ${P100_BUDGET_MS}ms
  1  an assertion failed
  2  could not run (missing dist/, server/browser never came up, items.icon
     unreachable)
`;

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try { await fetch(url); return; } catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error(`server at ${url} did not respond within ${timeoutMs}ms (last error: ${lastErr && lastErr.message})`);
}

function startPreviewServer(port) {
  const child = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const exited = new Promise((resolvePromise) => { child.on('exit', (code, signal) => resolvePromise({ code, signal })); });
  return {
    getStderr: () => stderr,
    exited,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timeout = new Promise((r) => setTimeout(r, 2000));
      await Promise.race([exited, timeout]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
}

/**
 * Runs entirely INSIDE the page (evaluated via `page.evaluate`) — this is
 * where `performance.now()` is legal (D-24: the page's own realm, not
 * anything `tools/check-imports.mjs` walks). Reaches `window.__ENGINE__.ctx`
 * exactly like `src/dev/shots.js`'s own `setup` functions do; imports
 * nothing (same "must survive toString()+eval"-style zero-closure shape,
 * applied here by hand rather than via that file's registry, since this is
 * a one-off benchmark page function, not a registered shot).
 */
function pageBenchmark({ heavyBaseId, timingSamples, timingWarmup }) {
  const engine = window.__ENGINE__;
  const items = engine && engine.ctx && typeof engine.ctx.get === 'function' ? engine.ctx.get('items') : null;
  if (!items || typeof items.icon !== 'function' || typeof items.__iconGenerate !== 'function' || typeof items.base !== 'function') {
    return { ok: false, error: 'items.icon / items.__iconGenerate / items.base not reachable on ctx.get(\'items\')' };
  }

  // FNV-1a over a canvas's pixel bytes + its dimensions — cheap, sync,
  // no crypto.subtle round trip needed. Two byte-identical bitmaps always
  // hash equal; a collision on genuinely different pixel data is
  // astronomically unlikely at this data size, and this is a diagnostic
  // proof, not a security boundary.
  function hashCanvas(canvas) {
    const g = canvas.getContext('2d');
    const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      h ^= data[i];
      h = Math.imul(h, 0x01000193);
    }
    return `${canvas.width}x${canvas.height}:${(h >>> 0).toString(16)}`;
  }

  const RARITIES = ['normal', 'superior', 'magic', 'rare', 'unique'];
  const bases = items.bases;
  const equipmentBases = [];
  for (let i = 0; i < bases.length; i++) {
    const b = bases[i];
    const isEquipment = (b.category === 'weapon' && b.id !== 'unarmed') || b.category === 'armour' || b.category === 'jewelry';
    if (isEquipment) equipmentBases.push(b);
  }

  let uid = 800000;
  let renderCount = 0;
  let nullCount = 0;
  const hashes = [];
  const failures = [];
  for (let i = 0; i < equipmentBases.length; i++) {
    const base = equipmentBases[i];
    for (let r = 0; r < RARITIES.length; r++) {
      const rarity = RARITIES[r];
      const item = {
        uid: uid++,
        baseId: base.id,
        rarity,
        ilvl: base.reqLevel || 1,
        identified: true,
        quantity: 1,
        rolls: { defense: 0, superior: rarity === 'superior' ? 10 : 0, damageMin: 0, damageMax: 0 },
        affixes: [],
        uniqueId: null, uniqueValues: [], nameOverride: null,
        durability: base.maxDurability, maxDurability: base.maxDurability,
        sockets: [], socketCount: 0,
        grid: null, slot: null, ground: null,
      };
      const canvas = items.icon(item);
      renderCount++;
      if (!canvas) { nullCount++; failures.push(`${base.id}|${rarity}`); continue; }
      hashes.push(hashCanvas(canvas));
    }
  }

  const uniqueHashes = new Set(hashes);

  // Timing pass — the raw, non-cached generator, against the heaviest
  // recipe x heaviest rarity overlay.
  const heavyBase = items.base(heavyBaseId);
  const timingOk = !!heavyBase;
  const samples = [];
  const canForceGc = typeof gc === 'function';
  if (timingOk) {
    for (let i = 0; i < timingWarmup; i++) {
      items.__iconGenerate(heavyBase, { rarity: 'unique', socketCount: 0, superior: false, identified: true, durability: heavyBase.maxDurability, maxDurability: heavyBase.maxDurability });
    }
    if (canForceGc) gc();
    for (let i = 0; i < timingSamples; i++) {
      // Collect BETWEEN samples, never inside the measured window — see
      // this file's header on `--expose-gc`.
      if (canForceGc) gc();
      const t0 = performance.now();
      items.__iconGenerate(heavyBase, { rarity: 'unique', socketCount: 0, superior: false, identified: true, durability: heavyBase.maxDurability, maxDurability: heavyBase.maxDurability });
      const t1 = performance.now();
      samples.push(t1 - t0);
    }
  }

  return {
    ok: true,
    equipmentBaseCount: equipmentBases.length,
    renderCount,
    nullCount,
    distinctCount: uniqueHashes.size,
    totalHashCount: hashes.length,
    failures,
    timingOk,
    canForceGc,
    samples,
  };
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) { console.error(`iconbench: ${args.error}`); process.exitCode = 2; return; }
  if (args.help) { console.log(HELP_TEXT); process.exitCode = 0; return; }

  if (!existsSync(DIST_INDEX)) {
    console.error(`iconbench: dist/index.html does not exist — run \`npm run build\` first`);
    process.exitCode = 2;
    return;
  }

  let server = null;
  let browser = null;
  let result = null;
  const t0 = Date.now();

  try {
    const port = await getFreePort();
    server = startPreviewServer(port);
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForServer(baseUrl, 5000);
    } catch (err) {
      const stderr = server.getStderr();
      throw new Error(`vite preview never came up on ${baseUrl}: ${err.message}${stderr ? `\n--- vite preview stderr ---\n${stderr}` : ''}`);
    }

    browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    const url = `${baseUrl}/?capture=1&lockstep=1&seed=${encodeURIComponent(DEFAULT_SEED_HEX)}`;
    if (args.verbose) console.log(`[iconbench] navigating to ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 5000 });
    await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 5000 });

    result = await page.evaluate(pageBenchmark, {
      heavyBaseId: HEAVY_BASE_ID,
      timingSamples: TIMING_SAMPLES,
      timingWarmup: TIMING_WARMUP,
    });

    if (args.verbose && consoleErrors.length > 0) {
      console.log(`[iconbench] ${consoleErrors.length} console error(s)/pageerror(s):`);
      for (const e of consoleErrors) console.log(`  ${e}`);
    }

    await context.close();
  } catch (err) {
    console.error(`iconbench: ${err.message}`);
    process.exitCode = 2;
    return;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop().catch(() => {});
  }

  if (!result || !result.ok) {
    console.error(`iconbench: could not run the in-page benchmark: ${result && result.error}`);
    process.exitCode = 2;
    return;
  }

  const failures = [];
  const expectedTotal = 61 * 5;
  if (result.equipmentBaseCount !== 61) {
    failures.push(`FAIL  ITEM15.01  equipment-base count  expected=61  actual=${result.equipmentBaseCount}`);
  }
  if (result.renderCount !== expectedTotal) {
    failures.push(`FAIL  ITEM15.02  render count  expected=${expectedTotal}  actual=${result.renderCount}`);
  }
  if (result.nullCount !== 0) {
    failures.push(`FAIL  ITEM15.03  null (failed) renders  expected=0  actual=${result.nullCount}  bases=${result.failures.join(',')}`);
  }
  if (result.distinctCount !== expectedTotal) {
    failures.push(`FAIL  ITEM15.04  distinct bitmaps  expected=${expectedTotal}  actual=${result.distinctCount}`);
  }

  const sorted = result.samples.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p100 = percentile(sorted, 100);
  if (!result.timingOk) {
    failures.push(`FAIL  ITEM15.05  timing pass  expected='${HEAVY_BASE_ID}' resolvable  actual=not found`);
  } else {
    if (!(p95 <= P95_BUDGET_MS)) failures.push(`FAIL  ITEM15.06  p95  expected<=${P95_BUDGET_MS}ms  actual=${p95.toFixed(4)}ms`);
    if (!(p100 <= P100_BUDGET_MS)) failures.push(`FAIL  ITEM15.07  p100  expected<=${P100_BUDGET_MS}ms  actual=${p100.toFixed(4)}ms`);
  }

  for (const f of failures) console.error(f);

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(
    `iconbench.mjs  equipmentBases=${result.equipmentBaseCount}  renders=${result.renderCount}  nullRenders=${result.nullCount}  distinct=${result.distinctCount}/${expectedTotal}  ` +
      `timing(n=${sorted.length})  p50=${p50.toFixed(4)}ms  p95=${p95.toFixed(4)}ms  p100=${p100.toFixed(4)}ms  budget(p95<=${P95_BUDGET_MS},p100<=${P100_BUDGET_MS})  elapsed=${elapsedS}s`,
  );
  console.log(`  RESULT: ${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({
      tool: 'iconbench.mjs',
      equipmentBaseCount: result.equipmentBaseCount,
      renderCount: result.renderCount,
      nullCount: result.nullCount,
      distinctCount: result.distinctCount,
      expectedTotal,
      timing: { n: sorted.length, p50, p95, p100, samples: sorted },
      failures,
    }, null, 2));
  }

  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`iconbench: unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 2;
});
