#!/usr/bin/env node
// tools/imagediff.mjs
//
// TEST-3 — `imagediff.mjs` (docs/spec/12-testing.md §9, §5): "compares them
// against tests/fixtures/shots/ and exits non-zero on ANY differing pixel."
// Zero tolerance, not a perceptual metric — see §9.2/D-12-5: the frame is
// deterministic by construction, and that is what makes exact comparison
// affordable.
//
// ---------------------------------------------------------------------------
// Two modes
// ---------------------------------------------------------------------------
// `tools/baseline.mjs` (TEST-15, M9, not this ticket's) is what will one day
// render the FULL shot set and hand this tool a directory to compare. Today
// there is exactly one shot and no `baseline.mjs`, but this tool's own job —
// "diff two PNGs, zero tolerance, clear failure output" — does not depend on
// that tool existing. Two ways in:
//
//   --shot <name> [--candidate <path>] [--fixture <path>]
//     The shot-oriented mode `baseline.mjs` will eventually drive.
//     `--candidate` defaults to `shots/<name>.png` (capture.mjs's own
//     non-`--bless` output location — see that tool's header) and
//     `--fixture` defaults to `tests/fixtures/shots/<name>.png` (the
//     committed baseline, 12-testing.md §6).
//
//   --a <path> --b <path>
//     A generic two-file diff, no shot registry involved. This is what this
//     ticket's own acceptance proof uses: two independent
//     `tools/capture.mjs --shot boot_clean` outputs, diffed directly against
//     each other, to demonstrate "repeat runs are pixel-identical" without
//     the committed fixture in the loop at all.
//
// Exactly one mode must be given — mixing `--shot` with `--a`/`--b`, or
// giving neither, is a usage error (exit 2).
//
// ---------------------------------------------------------------------------
// `--bless` here
// ---------------------------------------------------------------------------
// The common CLI contract (12-testing.md §5.1) gives every tool `--bless`.
// `tools/capture.mjs --bless` already writes straight to
// `tests/fixtures/shots/<name>.png`, which is enough to lay down the very
// first baseline (this ticket's brief says as much). `imagediff.mjs --bless`
// is a second, equally literal reading of "regenerate this tool's fixtures":
// in `--shot` mode it copies `--candidate` over `--fixture` BEFORE comparing
// (comparing a file against itself afterwards would be vacuous, so blessing
// short-circuits straight to a PASS). It requires `--shot` — there is no
// "the" fixture to write to in `--a`/`--b` mode, so combining `--bless` with
// that mode is a usage error (exit 2) rather than a silent no-op.
//
// ---------------------------------------------------------------------------
// `--seed` here
// ---------------------------------------------------------------------------
// Also part of the common contract, and, like `capture.mjs`'s, honestly
// inert: comparing two already-rendered PNGs draws nothing from any RNG.
// Accepted (never rejected) for CLI uniformity across every harness, echoed
// into `--json` output, and otherwise ignored.
//
// ---------------------------------------------------------------------------
// Exit codes (12-testing.md §5.1)
// ---------------------------------------------------------------------------
// 0  the two images are pixel-identical (same dimensions, zero differing
//    pixels)
// 1  at least one differing pixel, OR the dimensions differ (12-testing.md
//    §9: "differing pixel" and a size mismatch are both real, describable
//    comparison outcomes — not a tooling failure)
// 2  could not run (bad usage, a file is missing/unreadable/not a valid PNG)
// 3  unused — this tool does not itself run anything twice at a seed; it
//    diffs two already-produced files (see this file's header)
// 4  unused — there is no time/memory/allocation budget this tool can miss
//    other than its own 15 s wall-clock (12-testing.md §2), checked below
//    the same way capture.mjs checks its 8 s

import { PNG } from 'pngjs';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(REPO_ROOT, 'shots');
const FIXTURE_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'shots');

/** 12-testing.md §5's harness table: `imagediff.mjs` | P | ... | 15 s. */
const BUDGET_MS = 15000;

const HELP_TEXT = `imagediff.mjs — exact pixel comparison against the shot baseline (12-testing.md §9)

Usage:
  node tools/imagediff.mjs --shot <name> [--candidate <path>] [--fixture <path>]
  node tools/imagediff.mjs --a <path> --b <path>

Modes (exactly one):
  --shot <name>        compare shots/<name>.png against tests/fixtures/shots/<name>.png
    --candidate <path>   override the candidate path (default: shots/<name>.png)
    --fixture <path>     override the fixture path (default: tests/fixtures/shots/<name>.png)
  --a <path> --b <path>  compare two arbitrary PNGs directly, no fixture involved

Options (12-testing.md §5.1's common contract):
  --seed <hex>   accepted for CLI consistency; this tool draws no randomness, so it has no effect
  --json <path>  also write a machine-readable result to <path>
  --verbose      print both images' dimensions before comparing
  --bless        --shot mode only: copy the candidate over the fixture, then report PASS
  --help         print this message and exit 0

Exit codes:
  0  pixel-identical (same dimensions, zero differing pixels)
  1  at least one differing pixel, or a dimension mismatch
  2  could not run (bad usage, missing/unreadable/invalid PNG)
  3  unused by this tool — see its header
  4  unused by this tool — see its header
`;

function parseArgs(argv) {
  const args = {
    shot: null,
    candidate: null,
    fixture: null,
    a: null,
    b: null,
    seed: null,
    json: null,
    verbose: false,
    bless: false,
    help: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeVal = (flag) => {
      const val = argv[i + 1];
      if (val === undefined) {
        args.error = `${flag} requires an argument`;
        return undefined;
      }
      i++;
      return val;
    };
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--bless') {
      args.bless = true;
    } else if (arg === '--shot') {
      const v = takeVal('--shot');
      if (args.error) return args;
      args.shot = v;
    } else if (arg === '--candidate') {
      const v = takeVal('--candidate');
      if (args.error) return args;
      args.candidate = v;
    } else if (arg === '--fixture') {
      const v = takeVal('--fixture');
      if (args.error) return args;
      args.fixture = v;
    } else if (arg === '--a') {
      const v = takeVal('--a');
      if (args.error) return args;
      args.a = v;
    } else if (arg === '--b') {
      const v = takeVal('--b');
      if (args.error) return args;
      args.b = v;
    } else if (arg === '--seed') {
      const v = takeVal('--seed');
      if (args.error) return args;
      args.seed = v;
    } else if (arg === '--json') {
      const v = takeVal('--json');
      if (args.error) return args;
      args.json = v;
    } else {
      args.error = `unknown flag: ${arg} (see --help)`;
      return args;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// PNG loading + diffing
// ---------------------------------------------------------------------------

/** @returns {{ png: object } | { error: string }} */
function loadPng(path) {
  if (!existsSync(path)) return { error: `not found: ${relative(REPO_ROOT, path)}` };
  let buf;
  try {
    buf = readFileSync(path);
  } catch (err) {
    return { error: `could not read ${relative(REPO_ROOT, path)}: ${err.message}` };
  }
  try {
    return { png: PNG.sync.read(buf) };
  } catch (err) {
    return { error: `not a valid PNG: ${relative(REPO_ROOT, path)}: ${err.message}` };
  }
}

/**
 * @param {object} a - a `pngjs` image ({width,height,data}).
 * @param {object} b
 * @returns {{ sizeMismatch: boolean, diffCount: number, totalPixels: number, firstDiff: object | null }}
 */
function diffImages(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { sizeMismatch: true, diffCount: 0, totalPixels: 0, firstDiff: null };
  }
  const totalPixels = a.width * a.height;
  let diffCount = 0;
  let firstDiff = null;
  for (let i = 0; i < a.data.length; i += 4) {
    const same = a.data[i] === b.data[i] && a.data[i + 1] === b.data[i + 1] && a.data[i + 2] === b.data[i + 2] && a.data[i + 3] === b.data[i + 3];
    if (!same) {
      diffCount++;
      if (firstDiff === null) {
        const p = i / 4;
        firstDiff = {
          x: p % a.width,
          y: Math.floor(p / a.width),
          a: [a.data[i], a.data[i + 1], a.data[i + 2], a.data[i + 3]],
          b: [b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]],
        };
      }
    }
  }
  return { sizeMismatch: false, diffCount, totalPixels, firstDiff };
}

function toFailLine(id, scope, detail, expected, actual) {
  return `FAIL  ${id}  ${scope}  ${detail}  expected=${expected}  actual=${actual}  delta=—`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const t0 = Date.now();
  const args = parseArgs(process.argv.slice(2));

  if (args.error) {
    console.error(`imagediff: ${args.error}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(HELP_TEXT);
    process.exitCode = 0;
    return;
  }

  const shotMode = args.shot !== null;
  const pairMode = args.a !== null || args.b !== null;

  if (shotMode && pairMode) {
    console.error('imagediff: --shot and --a/--b are mutually exclusive — pick one mode (see --help)');
    process.exitCode = 2;
    return;
  }
  if (!shotMode && !pairMode) {
    console.error('imagediff: give either --shot <name> or --a <path> --b <path> (see --help)');
    process.exitCode = 2;
    return;
  }
  if (pairMode && (args.a === null || args.b === null)) {
    console.error('imagediff: --a/--b mode needs both --a and --b');
    process.exitCode = 2;
    return;
  }
  if (args.bless && !shotMode) {
    console.error('imagediff: --bless requires --shot mode — there is no single fixture to write to in --a/--b mode');
    process.exitCode = 2;
    return;
  }

  let pathA;
  let pathB;
  let scopeLabel;
  if (shotMode) {
    pathA = resolve(REPO_ROOT, args.candidate ?? join(OUT_DIR, `${args.shot}.png`));
    pathB = resolve(REPO_ROOT, args.fixture ?? join(FIXTURE_DIR, `${args.shot}.png`));
    scopeLabel = `shot=${args.shot}`;
  } else {
    pathA = resolve(REPO_ROOT, args.a);
    pathB = resolve(REPO_ROOT, args.b);
    scopeLabel = `a=${relative(REPO_ROOT, pathA)} b=${relative(REPO_ROOT, pathB)}`;
  }

  if (args.bless) {
    if (!existsSync(pathA)) {
      console.error(`imagediff: --bless needs the candidate to exist first: ${relative(REPO_ROOT, pathA)} (run \`node tools/capture.mjs --shot ${args.shot}\`)`);
      process.exitCode = 2;
      return;
    }
    mkdirSync(dirname(pathB), { recursive: true });
    copyFileSync(pathA, pathB);
    console.log(`imagediff.mjs  seed=${args.seed ?? 'n/a'}  ${scopeLabel}  blessed ${relative(REPO_ROOT, pathB)} from ${relative(REPO_ROOT, pathA)}  elapsed=${((Date.now() - t0) / 1000).toFixed(2)}s`);
    console.log('  RESULT: PASS (blessed)');
    if (args.json) {
      writeFileSync(args.json, JSON.stringify({ tool: 'imagediff.mjs', exitCode: 0, blessed: true, candidate: relative(REPO_ROOT, pathA), fixture: relative(REPO_ROOT, pathB) }, null, 2));
    }
    process.exitCode = 0;
    return;
  }

  const loadedA = loadPng(pathA);
  const loadedB = loadPng(pathB);
  if (loadedA.error || loadedB.error) {
    if (loadedA.error) console.error(`imagediff: ${loadedA.error}`);
    if (loadedB.error) console.error(`imagediff: ${loadedB.error}`);
    process.exitCode = 2;
    return;
  }

  if (args.verbose) {
    console.log(`[imagediff] a: ${relative(REPO_ROOT, pathA)} ${loadedA.png.width}x${loadedA.png.height}`);
    console.log(`[imagediff] b: ${relative(REPO_ROOT, pathB)} ${loadedB.png.width}x${loadedB.png.height}`);
  }

  const result = diffImages(loadedA.png, loadedB.png);
  const failures = [];
  const repro = shotMode ? `node tools/imagediff.mjs --shot ${args.shot}` : `node tools/imagediff.mjs --a ${relative(REPO_ROOT, pathA)} --b ${relative(REPO_ROOT, pathB)}`;

  if (result.sizeMismatch) {
    failures.push(
      toFailLine(
        '12.IMG02',
        scopeLabel,
        'image dimensions differ',
        `${loadedA.png.width}x${loadedA.png.height}`,
        `${loadedB.png.width}x${loadedB.png.height}`,
      ),
    );
  } else if (result.diffCount > 0) {
    const fd = result.firstDiff;
    failures.push(
      toFailLine(
        '12.IMG01',
        scopeLabel,
        `${result.diffCount}/${result.totalPixels} pixel(s) differ (first at x=${fd.x} y=${fd.y}: a=[${fd.a.join(',')}] b=[${fd.b.join(',')}])`,
        '0 differing pixels',
        `${result.diffCount} differing pixels`,
      ),
    );
  }

  for (const f of failures) {
    console.error(f);
    console.error(`  repro: ${repro}`);
  }

  const elapsedMs = Date.now() - t0;
  let exitCode = failures.length > 0 ? 1 : 0;
  const notes = [];
  if (exitCode === 0 && elapsedMs > BUDGET_MS) {
    notes.push(`NOTE  budget exceeded: ${(elapsedMs / 1000).toFixed(2)}s > ${(BUDGET_MS / 1000).toFixed(2)}s (12-testing.md §2)`);
  }
  for (const n of notes) console.log(n);

  console.log(
    `imagediff.mjs  seed=${args.seed ?? 'n/a'}  ${scopeLabel}  size=${result.sizeMismatch ? `${loadedA.png.width}x${loadedA.png.height} vs ${loadedB.png.width}x${loadedB.png.height}` : `${loadedA.png.width}x${loadedA.png.height}`}  diffPixels=${result.diffCount}  elapsed=${(elapsedMs / 1000).toFixed(2)}s`,
  );
  console.log(`  RESULT: ${exitCode === 0 ? 'PASS' : `FAIL (${failures.length})`}`);

  if (args.json) {
    writeFileSync(
      args.json,
      JSON.stringify(
        {
          tool: 'imagediff.mjs',
          exitCode,
          elapsedMs,
          a: relative(REPO_ROOT, pathA),
          b: relative(REPO_ROOT, pathB),
          sizeMismatch: result.sizeMismatch,
          diffCount: result.diffCount,
          totalPixels: result.totalPixels,
          firstDiff: result.firstDiff,
          seed: args.seed,
        },
        null,
        2,
      ),
    );
  }

  process.exitCode = exitCode;
}

main();
