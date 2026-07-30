#!/usr/bin/env node
// tools/capture.mjs
//
// TEST-3 — `capture.mjs` (docs/spec/12-testing.md §5, the B-surface harness
// row: "one named shot renders and is not blank", 8 s budget). This is the
// tool ARCHITECTURE.md rule 8 names as the minimum bar: "`npm run build`
// must pass and `node tools/capture.mjs` must produce a frame after your
// change."
//
// ---------------------------------------------------------------------------
// What this does
// ---------------------------------------------------------------------------
//   1. Validates `--shot` against `src/dev/shots.js`'s registry — before
//      touching a server or a browser, so a bad `--shot` fails in
//      milliseconds (this is what keeps this tool's own CLI-error paths
//      cheap enough to unit-test on the N surface — see
//      tests/tools/capture.test.js).
//   2. Serves `dist/` as static files (either its own `vite preview`,
//      spawned and torn down around this one call, or an already-running
//      server passed via `--base-url` — see "Serving the build" below).
//   3. Opens a fresh Playwright Chromium page at
//      `<base>/?capture=1&lockstep=1[&seed=<hex>]`, sized 1280×720
//      (12-testing.md §6 — the pixel gate's fixed resolution), and waits for
//      `window.__READY__ === true` (`src/main.js`'s B13 handshake).
//   4. If the shot declares a `setup` (`src/dev/shots.js`), runs it ONCE,
//      inside the page, against the live `window.__ENGINE__.ctx` — see
//      "Running a shot's setup" below. `boot_clean`'s `setup` is `null`, so
//      this step is a strict no-op for it (ARCHITECTURE.md rule 8 / this
//      tool's own contract: the boot must never change under this).
//   5. Pumps the shot's own `steps` (0 for `boot_clean`) through
//      `window.__ENGINE__.frame(FIXED_DT)` — never rAF — using
//      `src/dev/shots.js`'s `pumpShot`, injected into the page (see that
//      file's header for why this is safe and why it is the ONE copy of the
//      stepping loop).
//   6. Reads the `#game` canvas back via `canvas.toDataURL('image/png')`
//      (see "Reading the pixels" below), decodes it with `pngjs`, and
//      asserts it is non-blank and exactly 1280×720. Also reads
//      `renderer.info.render.calls` off the live `render` subsystem — see
//      "Draw-call count" below — so a shot's acceptance criterion (e.g. `08
//      §11 step 4`'s "1 draw call") is a number this tool prints, not one a
//      caller has to go dig for separately.
//   7. Writes the PNG to `shots/<name>.png` (gitignored scratch output) or,
//      with `--bless`, to `tests/fixtures/shots/<name>.png` — the committed
//      baseline `tools/imagediff.mjs` compares against.
//
// ---------------------------------------------------------------------------
// Running a shot's setup
// ---------------------------------------------------------------------------
// `src/dev/shots.js`'s header ("pumpShot — AND a shot's own setup — must
// survive toString()+eval") is the contract this step relies on: `setup`, if
// present, has zero free variables, so its source can be lifted into the
// page the exact same way `pumpShot`'s already is, a few lines below. It is
// called as `setup(window.__ENGINE__, window.__ENGINE__.ctx)` —
// `src/core/engine.js`'s constructor stores the real `ctx` on the engine
// instance verbatim (`this.ctx = ctx`), so this is the one live object a
// page-evaluated function can reach `ctx.scene`/`ctx.get(id)` through without
// importing anything. This has to run BEFORE `pumpShot` ("run once before
// the pump" — shots.js's own doc on the field), so a `setup` that spawns
// something sees it survive however many steps the shot then pumps.
// `await`ed here regardless of whether it returns a value or a `Promise`
// (the documented `void | Promise<void>` shape) — awaiting a plain value is
// a no-op, so this stays correct for a synchronous `setup` too (every
// `setup` registered today, including `actor_ranker`'s, is synchronous).
//
// ---------------------------------------------------------------------------
// Draw-call count
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md`'s "Render integration" names `r.renderer` (the real
// `THREE.WebGLRenderer`) as part of `render`'s public surface
// (`ctx.get('render').renderer`); `renderer.info.render.calls` is Three's own
// running count of draw calls issued by the LAST completed `render()` call —
// exactly what `08 §11 step 4`'s "1 draw call for the actor" and similar
// per-shot criteria need proof of, not just an assertion. Read once, right
// after the pump (so it reflects the frame this tool is about to screenshot,
// not a stale prior one), and reported as `drawCalls` in both the console
// summary and `--json` output. Guarded with a `typeof` check the same way
// `src/main.js#renderFrame` guards `ctx.peek('render')` — `render` is always
// registered in practice (`src/main.js`'s B4), but this tool never assumes
// another subsystem's shape without checking, the same discipline
// `ARCHITECTURE.md` rule 2 asks of every subsystem.
//
// ---------------------------------------------------------------------------
// Serving the build
// ---------------------------------------------------------------------------
// Decision (this ticket's to make — see its brief): `capture.mjs` spawns its
// own `vite preview` by default, on an OS-assigned free port, and tears it
// down in a `finally` no matter how the run ends. That makes
// `node tools/capture.mjs --shot boot_clean` a true single command with zero
// setup, which is what ARCHITECTURE.md rule 8 asks for. `--base-url <url>`
// opts out of that and points at an already-running server instead — useful
// for a future multi-shot harness (`tools/baseline.mjs`, TEST-15) that wants
// to pay the `vite preview` startup cost once for many shots, and it is what
// lets this tool's own test suite share one server across several
// invocations instead of paying that cost per test.
//
// `capture.mjs` never runs `npm run build` itself: `dist/` is a stage-1
// concern (12-testing.md §10's "lint" stage runs `npm run build` before
// stage 4's "visual" stage, which is this tool, ever starts) and re-building
// on every capture would blow the 8 s budget by itself on a project this
// size. Missing `dist/index.html` is therefore a `--could not run--` (exit 2)
// with a message naming the fix, not a silent rebuild.
//
// ---------------------------------------------------------------------------
// Reading the pixels
// ---------------------------------------------------------------------------
// `page.locator('#game').screenshot()` — element screenshots capture exactly
// the canvas's on-screen bounds with no page chrome around it.
//
// The first version of this tool tried `canvas.toDataURL('image/png')`,
// read from inside the page right after the pump call, on the theory that a
// direct canvas readback is more exact than a compositor screenshot. Live on
// this tree it came back all-zero (0/921600 non-blank pixels) even though
// `boot_clean` visibly renders its clear colour. Cause, confirmed by reading
// `src/render/index.js` (RNDR-1, locked): its `WebGLRenderer` is constructed
// without `preserveDrawingBuffer: true` (the correct choice for a real game —
// that flag has a real perf cost and nothing in this engine needs it), so the
// browser is free to clear the drawing buffer once it has been composited to
// the screen. `toDataURL()` runs in a SEPARATE `page.evaluate()` round trip
// after the pump, i.e. after that composite/clear has already happened, so it
// read back nothing. `page.screenshot()` has no such problem: it captures
// whatever the compositor actually painted to the screen, which is the one
// artifact that is guaranteed to still hold the frame's real pixels.
//
// ---------------------------------------------------------------------------
// The non-blank check
// ---------------------------------------------------------------------------
// Per this ticket's brief: not "the file exists", not "the file is > 0
// bytes" — "the frame contains a pixel that is neither black nor
// transparent". A pixel that is both `alpha === 0` (nothing was ever drawn
// there — the canvas's own default) AND `r === g === b === 0` (opaque flat
// black — the most common "the renderer never bound" failure shape) is
// "blank"; `boot_clean` on the current tree clears to `0x0b0e14` composited
// through AgX/sRGB, i.e. an opaque dark blue-grey, which trivially clears
// this bar — see `checkNonBlank` below.
//
// ---------------------------------------------------------------------------
// The one CLI seed knob that is currently a no-op, and why
// ---------------------------------------------------------------------------
// The common CLI contract (12-testing.md §5.1) gives every tool `--seed`.
// `src/main.js` (locked, not this ticket's) hardcodes `worldSeed = 0x5eed1234`
// whenever `?capture=1` makes `config.deterministic` true — `config.seed`
// (what `?seed=` feeds) is only ever consulted on the NON-deterministic path
// (11-flows.md §14.2). So today, `--seed` on this tool cannot change
// `boot_clean`'s pixels no matter what value is given: capture mode always
// wins with its own constant. `--seed` is still accepted (never rejected —
// unlike `check-imports.mjs`/`check-fixed.mjs`'s stance on flags they have
// no use for at all) and forwarded to the URL as `?seed=<hex>`, both so the
// CLI stays uniform across every harness and so a future `main.js` that
// starts honouring `?seed=` under capture mode picks this up for free. A
// `--seed` value other than the default prints a NOTE saying exactly this,
// rather than silently pretending it did something.
//
// ---------------------------------------------------------------------------
// Exit codes (12-testing.md §5.1)
// ---------------------------------------------------------------------------
// 0  the shot rendered, is non-blank, and is exactly 1280×720
// 1  an assertion failed (blank frame, or wrong dimensions)
// 2  could not run (bad CLI usage, unknown shot, missing dist/, the server
//    never came up, the page never reached __READY__, no #game canvas)
// 3  unused by this tool — see the header note: a single `capture.mjs`
//    invocation never runs the shot twice at one seed, so there is nothing
//    for this tool itself to detect as "non-deterministic between two runs".
//    (The two-runs-identical property IS checked — by `tools/imagediff.mjs`
//    comparing two separate `capture.mjs` outputs; see this ticket's report.)
// 4  every assertion passed but the 8 s budget (12-testing.md §2) was
//    exceeded

import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getShot, listShotNames, pumpShot } from '../src/dev/shots.js';
import { FIXED_DT } from '../src/core/engine.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_INDEX = join(REPO_ROOT, 'dist', 'index.html');
const OUT_DIR = join(REPO_ROOT, 'shots');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'shots');

/** `src/main.js`'s own capture-mode constant (11-flows.md §14.2) — see the
 * header's "one CLI seed knob that is currently a no-op" note. */
const DEFAULT_SEED_HEX = '0x5eed1234';

/** 12-testing.md §6 — the pixel gate's fixed resolution. */
const VIEWPORT = { width: 1280, height: 720 };

/** 12-testing.md §5's harness table: `capture.mjs` | B | ... | 8 s. */
const BUDGET_MS = 8000;

/** The team's live-verified flag set for a headless Chromium that must still
 * yield a real WebGL2 context — see this ticket's brief. */
const CHROMIUM_ARGS = ['--use-gl=angle', '--use-angle=default', '--enable-unsafe-swiftshader'];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `capture.mjs — renders one named shot and asserts it is not blank (12-testing.md §5)

Usage:
  node tools/capture.mjs --shot <name> [options]

Required:
  --shot <name>      the shot to render. Valid: ${listShotNames().join(', ')}

Options (12-testing.md §5.1's common contract):
  --seed <hex>        forwarded to the page as ?seed=<hex>; a no-op while
                       ?capture=1 forces worldSeed=0x5eed1234 — see this
                       file's header. Default: ${DEFAULT_SEED_HEX}
  --json <path>       also write a machine-readable result to <path>
  --verbose           print the boot log and per-step diagnostics
  --bless             write straight to tests/fixtures/shots/<name>.png
                       instead of the scratch shots/<name>.png
  --help              print this message and exit 0

Extra, this tool's own:
  --base-url <url>    use an already-running static server instead of
                       spawning our own \`vite preview\` (see this file's
                       header, "Serving the build")

Exit codes:
  0  shot rendered, non-blank, exactly 1280x720
  1  an assertion failed (blank frame, or wrong dimensions)
  2  could not run (bad usage, unknown shot, missing dist/, server/browser
     never came up)
  3  unused by this tool — see this file's header
  4  every assertion passed but the 8s budget was exceeded
`;

function parseArgs(argv) {
  const args = {
    shot: null,
    seed: null,
    json: null,
    verbose: false,
    bless: false,
    baseUrl: null,
    help: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '--bless') {
      args.bless = true;
    } else if (a === '--shot') {
      const val = argv[i + 1];
      if (val === undefined) {
        args.error = '--shot requires a name argument';
        return args;
      }
      args.shot = val;
      i++;
    } else if (a === '--seed') {
      const val = argv[i + 1];
      if (val === undefined) {
        args.error = '--seed requires a hex argument';
        return args;
      }
      args.seed = val;
      i++;
    } else if (a === '--json') {
      const val = argv[i + 1];
      if (val === undefined) {
        args.error = '--json requires a path argument';
        return args;
      }
      args.json = val;
      i++;
    } else if (a === '--base-url') {
      const val = argv[i + 1];
      if (val === undefined) {
        args.error = '--base-url requires a URL argument';
        return args;
      }
      args.baseUrl = val;
      i++;
    } else {
      args.error = `unknown flag: ${a} (see --help)`;
      return args;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Serving dist/ — see this file's header, "Serving the build"
// ---------------------------------------------------------------------------

/** @returns {Promise<number>} a free TCP port on 127.0.0.1. */
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

/** Polls `url` with plain `fetch` until it responds (any status — a 404 on
 * `/` would still prove the server is up) or `timeoutMs` elapses. */
async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`server at ${url} did not respond within ${timeoutMs}ms (last error: ${lastErr && lastErr.message})`);
}

/**
 * Spawns `vite preview` bound to `port`, serving the repo's own `dist/`.
 * Torn down by the caller (`stop()`) in a `finally` — never left running.
 */
function startPreviewServer(port) {
  const child = spawn(process.execPath, [join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(port), '--strictPort'], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise((resolvePromise) => {
    child.on('exit', (code, signal) => resolvePromise({ code, signal }));
  });
  return {
    child,
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

// ---------------------------------------------------------------------------
// The non-blank check — see this file's header
// ---------------------------------------------------------------------------

/**
 * @param {{ width: number, height: number, data: Buffer }} png
 * @returns {{ nonBlank: boolean, nonBlankCount: number, totalPixels: number, samplePixel: {x:number,y:number,r:number,g:number,b:number,a:number} }}
 */
function checkNonBlank(png) {
  const { width, height, data } = png;
  const totalPixels = width * height;
  let nonBlankCount = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a > 0 && (r > 0 || g > 0 || b > 0)) nonBlankCount++;
  }
  const cx = Math.min(width - 1, Math.floor(width / 2));
  const cy = Math.min(height - 1, Math.floor(height / 2));
  const ci = (cy * width + cx) * 4;
  const samplePixel = { x: cx, y: cy, r: data[ci], g: data[ci + 1], b: data[ci + 2], a: data[ci + 3] };
  return { nonBlank: nonBlankCount > 0, nonBlankCount, totalPixels, samplePixel };
}

// ---------------------------------------------------------------------------
// Reporting — 12-testing.md §12's failure shape
// ---------------------------------------------------------------------------

function toFailLine(id, scope, detail, expected, actual) {
  return `FAIL  ${id}  ${scope}  ${detail}  expected=${expected}  actual=${actual}  delta=—`;
}

function reproLine(shotName, seedArg) {
  const seedPart = seedArg ? ` --seed ${seedArg}` : '';
  return `  repro: node tools/capture.mjs --shot ${shotName}${seedPart}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));

  if (args.error) {
    console.error(`capture: ${args.error}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(HELP_TEXT);
    process.exitCode = 0;
    return;
  }
  if (!args.shot) {
    console.error(`capture: --shot is required (valid: ${listShotNames().join(', ')}) — see --help`);
    process.exitCode = 2;
    return;
  }

  let shot;
  try {
    shot = getShot(args.shot);
  } catch (err) {
    console.error(`capture: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  if (!args.baseUrl && !existsSync(DIST_INDEX)) {
    console.error(`capture: ${relative(REPO_ROOT, DIST_INDEX)} does not exist — run \`npm run build\` first (this tool never builds for you; see its header)`);
    process.exitCode = 2;
    return;
  }

  const seedHex = args.seed ?? DEFAULT_SEED_HEX;
  const notes = [];
  if (args.seed && args.seed !== DEFAULT_SEED_HEX) {
    notes.push(
      `NOTE  --seed ${args.seed} has no effect on this shot's pixels: src/main.js hardcodes worldSeed=${DEFAULT_SEED_HEX} whenever ?capture=1 (11-flows.md §14.2) — see this file's header`,
    );
  }

  let server = null;
  let browser = null;
  const failures = [];
  let png = null;
  let stepsRan = 0;
  let bootLog = null;
  let drawCalls = null;
  let baseUrl = args.baseUrl;

  try {
    if (!baseUrl) {
      const port = await getFreePort();
      server = startPreviewServer(port);
      baseUrl = `http://127.0.0.1:${port}`;
      try {
        await waitForServer(baseUrl, 5000);
      } catch (err) {
        const stderr = server.getStderr();
        throw new Error(`vite preview never came up on ${baseUrl}: ${err.message}${stderr ? `\n--- vite preview stderr ---\n${stderr}` : ''}`);
      }
    }

    browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();

    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(String(err));
    });

    const url = `${baseUrl}/?capture=1&lockstep=1&seed=${encodeURIComponent(seedHex)}`;
    if (args.verbose) console.log(`[capture] navigating to ${url}`);
    await page.goto(url, { waitUntil: 'load', timeout: 5000 });

    await page.waitForFunction(() => window.__READY__ === true, null, { timeout: 5000 });

    if (args.verbose) {
      bootLog = await page.evaluate(() => (window.__ENGINE__ && window.__ENGINE__.__boot) || null);
      if (bootLog) {
        console.log('[capture] boot log:');
        for (const entry of bootLog) console.log(`  ${entry.id}  ${entry.stage}  ${entry.status}`);
      }
    }

    // If the shot declares a setup, run it once, before the pump — see this
    // file's header, "Running a shot's setup". `boot_clean.setup === null`,
    // so this whole block is skipped for it: byte-for-byte the same
    // behaviour as before this ticket, which is what keeps `imagediff --shot
    // boot_clean` at `diffPixels=0`.
    if (shot.setup) {
      if (args.verbose) console.log(`[capture] running setup for shot '${args.shot}'`);
      await page.evaluate(
        ({ src }) => {
          // eslint-disable-next-line no-eval -- see src/dev/shots.js's
          // header: a shot's `setup`, like `pumpShot`, is lifted verbatim
          // into the page because window.__ENGINE__ (and its .ctx) only
          // exist in this realm.
          const fn = (0, eval)(`(${src})`);
          return fn(window.__ENGINE__, window.__ENGINE__.ctx);
        },
        { src: shot.setup.toString() },
      );
    }

    stepsRan = await page.evaluate(
      ({ src, steps, dt }) => {
        // eslint-disable-next-line no-eval -- see src/dev/shots.js's header:
        // this is `pumpShot`'s own source, lifted verbatim into the page
        // because window.__ENGINE__ only exists in this realm.
        const fn = (0, eval)(`(${src})`);
        return fn(window.__ENGINE__, steps, dt);
      },
      { src: pumpShot.toString(), steps: shot.steps, dt: FIXED_DT },
    );

    // See this file's header, "Draw-call count" — read right after the
    // pump, before the screenshot, so it reflects the frame about to be
    // captured. `render` is always registered in practice, but this tool
    // never assumes another subsystem's shape without checking (same
    // discipline as `src/main.js#renderFrame`'s own `ctx.peek` guard).
    drawCalls = await page.evaluate(() => {
      const engine = window.__ENGINE__;
      const render = engine && engine.ctx && typeof engine.ctx.peek === 'function' ? engine.ctx.peek('render') : null;
      return render && render.renderer && render.renderer.info && render.renderer.info.render
        ? render.renderer.info.render.calls
        : null;
    });

    const canvasExists = await page.evaluate(() => document.getElementById('game') !== null);
    if (!canvasExists) throw new Error("page has no '#game' canvas to read pixels from");

    const pngBuffer = await page.locator('#game').screenshot({ type: 'png' });
    png = PNG.sync.read(pngBuffer);

    if (consoleErrors.length > 0 && args.verbose) {
      console.log(`[capture] ${consoleErrors.length} console error(s)/pageerror(s) during boot:`);
      for (const e of consoleErrors) console.log(`  ${e}`);
    }

    await context.close();
  } catch (err) {
    console.error(`capture: ${err.message}`);
    process.exitCode = 2;
    return;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.stop().catch(() => {});
  }

  // --- Assertions -----------------------------------------------------------
  const scope = `shot=${args.shot}`;

  if (png.width !== VIEWPORT.width || png.height !== VIEWPORT.height) {
    failures.push(
      toFailLine(
        '12.CAP02',
        scope,
        '12-testing.md §6: shots are pinned at the pixel gate\'s fixed resolution',
        `${VIEWPORT.width}x${VIEWPORT.height}`,
        `${png.width}x${png.height}`,
      ),
    );
  }

  const nb = checkNonBlank(png);
  if (!nb.nonBlank) {
    failures.push(
      toFailLine(
        '12.CAP01',
        scope,
        'every pixel is either fully transparent or opaque black — the frame is blank',
        'non-blank',
        'blank',
      ),
    );
  }

  // Always write the PNG, pass or fail — a blank/wrong-size frame is exactly
  // what a human needs to see, not just be told about.
  const outPath = args.bless ? join(FIXTURE_DIR, `${args.shot}.png`) : join(OUT_DIR, `${args.shot}.png`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, PNG.sync.write(png));

  const elapsedMs = Date.now() - t0;
  let exitCode;
  if (failures.length > 0) {
    exitCode = 1;
  } else if (elapsedMs > BUDGET_MS) {
    exitCode = 4;
    notes.push(`NOTE  budget exceeded: ${(elapsedMs / 1000).toFixed(2)}s > ${(BUDGET_MS / 1000).toFixed(2)}s (12-testing.md §2)`);
  } else {
    exitCode = 0;
  }

  for (const n of notes) console.log(n);
  for (const f of failures) {
    console.error(f);
    console.error(reproLine(args.shot, args.seed));
  }

  console.log(
    `capture.mjs  seed=${seedHex}  shot=${args.shot}  size=${png.width}x${png.height}  nonBlankPixels=${nb.nonBlankCount}/${nb.totalPixels}  drawCalls=${drawCalls}  stepsRan=${stepsRan}  blessed=${args.bless}  out=${relative(REPO_ROOT, outPath)}  elapsed=${(elapsedMs / 1000).toFixed(2)}s`,
  );
  console.log(`  RESULT: ${exitCode === 0 ? 'PASS' : exitCode === 4 ? 'PASS (budget exceeded)' : `FAIL (${failures.length})`}`);

  if (args.json) {
    const payload = {
      tool: 'capture.mjs',
      exitCode,
      elapsedMs,
      shot: args.shot,
      seed: seedHex,
      width: png.width,
      height: png.height,
      nonBlankPixels: nb.nonBlankCount,
      totalPixels: nb.totalPixels,
      samplePixel: nb.samplePixel,
      drawCalls,
      stepsRan,
      blessed: args.bless,
      outPath: relative(REPO_ROOT, outPath),
      failures: failures.length,
      bootLog,
    };
    writeFileSync(args.json, JSON.stringify(payload, null, 2));
  }

  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(`capture: unexpected error: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 2;
});
