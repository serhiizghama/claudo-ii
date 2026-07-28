#!/usr/bin/env node
// tools/check-imports.mjs
//
// TEST-2 — the N/B boundary lint (docs/spec/12-testing.md §2.1).
//
// ---------------------------------------------------------------------------
// What this checks
// ---------------------------------------------------------------------------
// Starting from every file under the N-surface roots below, this walks the
// `import` graph TRANSITIVELY (a helper the root imports, that in turn
// imports `three`, is exactly as illegal as importing `three` directly) and
// fails if the closure reaches:
//   - the `three` package (any specifier `'three'` or `'three/...'`), or
//   - the bare identifiers `document` / `window` (any property access on
//     them, anywhere in a reached file's real code), or
//   - a call to `performance.now()`.
//
// Required roots, verbatim from 12-testing.md §2.1: `src/combat/`,
// `src/items/`, `src/skills/`, `src/nav/`, `src/world/data/`, and "every
// `data/` directory" (auto-discovered below — this also covers
// `src/world/data/` a second time, harmlessly deduplicated).
//
// `src/render/` is deliberately NOT scanned: it is the one subsystem that is
// *supposed* to import `three` (ARCHITECTURE.md's ownership map), so an
// N/B-boundary lint over it would be a permanent, meaningless failure.
//
// `src/core/` is not one of 12-testing.md §2.1's five literal roots either,
// but its own module headers (see src/core/config.js, src/core/input.js)
// say in as many words that they are "checked by tools/check-imports.mjs
// (TEST-2)" for staying `three`-free — every core module is loaded headlessly
// by every harness (ARCHITECTURE.md, "Node-safe" notes throughout
// src/core/*.js), so a future `import * as THREE from 'three'` landing there
// by accident is exactly the class of regression this tool exists to catch.
// It is included below with a NARROWER rule than the five gameplay roots,
// deliberately: `src/core/config.js` and `src/core/input.js` reference
// `window` / `document` / `location` on purpose, always behind a
// `typeof x !== 'undefined'` guard, as their sanctioned way of staying
// Node-safe while still working in a browser. A blanket "no window/document
// anywhere" rule would fail that legitimate, already-shipped code. So
// `src/core/` is checked for the `three` import only — never for the
// `document`/`window`/`performance.now()` globals. See this file's report
// for the reasoning spelled out.
//
// `src/physics/` and `src/actors/` are likewise not in 12-testing.md §2.1's
// literal five (neither has a `data/` subdirectory for the auto-discovery to
// catch), but 02-api-contracts.md §4 declares physics "headless... runs
// headless in Node", and PHYS-1/PHYS-2/ACTR-1 shipped that promise
// voluntarily — nothing mechanical held them to it, and nothing stops
// PHYS-3..5 / ACTR-2..17 from breaking it later, silently, until `mapgen`
// (M5) stops booting. Added here on request (O-22), on the `src/core/`
// pattern — `three`-only, not the full `document`/`window`/
// `performance.now()` sweep. Unlike `src/core/`, there is today no known
// legitimate guarded browser-global read in either directory to protect —
// see this ticket's report for the recommendation to reconsider going
// stricter (`checkGlobals: true`) once that's confirmed to stay true.
//
// ---------------------------------------------------------------------------
// How imports are parsed — no dependency, two honest regex passes
// ---------------------------------------------------------------------------
// `ARCHITECTURE.md` rule 3 forbids new dependencies, so there is no real JS
// parser here. Two regex passes over a *masked* copy of the source (comments
// blanked so a docstring mentioning "import ... from 'three'" in prose never
// matches) cover every import form 12-testing.md §2.1 names:
//   - static `import ... from '...'` / `export ... from '...'`
//   - bare `import '...'`
//   - dynamic `import('...')`
// A dynamic import built from a template literal or a variable
// (`import(someVar)`, `import(`${base}/x.js`)`) is not statically
// resolvable and is silently not walked — the same "defeatable by a
// computed access" tradeoff 12-testing.md §4.5 accepts for check-fixed.mjs.
//
// The `document`/`window`/`performance.now()` scan runs over a SECOND,
// stricter mask that also blanks string and template-literal contents (so a
// log message like `"never touches window"` cannot trip it), which is why
// import extraction and the forbidden-global scan use two different masked
// strings — see `maskComments` vs `maskCommentsAndStrings` below.
//
// ---------------------------------------------------------------------------
// CLI contract (12-testing.md §5.1)
// ---------------------------------------------------------------------------
// Implemented: --json <path>, --verbose, --help, exit codes 0/1/2.
// NOT implemented, on purpose: --seed (this lint has no randomness — the
// same file tree always produces the same result) and --bless (this lint
// has no fixtures to regenerate). Passing either is reported as an error
// (exit 2) rather than silently accepted, so a caller never mistakes silence
// for support.
//
// Exit codes: 0 every check passed. 1 at least one boundary violation.
// 2 could not run (bad CLI usage, or 02-api-contracts.md-style structural
// problem — in practice this tool has no external fixture to fail to load,
// so today only bad CLI usage reaches this code).

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The base every printed/JSON path is shown relative to. Defaults to
 * `REPO_ROOT` (today's behaviour, unchanged); `main()` repoints it to
 * `--root <dir>` when given, so a test run against a disposable tree prints
 * clean `combat/probe.js`-style paths instead of a long `../../../tmp/...`
 * chain. Read only by the formatting functions below, all of which are
 * called after `main()` has set it. */
let DISPLAY_ROOT = REPO_ROOT;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `check-imports.mjs — the N-surface / three,document,window,performance.now() boundary lint

Usage:
  node tools/check-imports.mjs [--root <dir>] [--json <path>] [--verbose] [--help]

Walks the transitive import closure of every file under the N-surface roots
(src/combat/, src/items/, src/skills/, src/nav/, src/world/data/, every
data/ directory, and src/core/, src/physics/, src/actors/ for the 'three'
import only) and fails if the closure reaches the 'three' package or the
document/window/performance.now() browser globals. See this file's header
for the full contract.

Options:
  --root <dir>    scan <dir> as if it were src/ (roots are resolved relative
                  to it), instead of the real <repo>/src/. Not part of
                  12-testing.md §5.1's common CLI contract — added so a test
                  suite can exercise this tool against a disposable synthetic
                  tree and never touch the real src/ (see this ticket's
                  report, O-24)
  --json <path>   also write a machine-readable result to <path>
  --verbose       print every file visited, not just failures
  --help          print this message and exit 0

Exit codes:
  0  every check passed
  1  at least one boundary violation
  2  could not run (bad CLI usage)

Not implemented (there is nothing for them to do here — see the header):
  --seed   this lint has no randomness; the same tree always gives the same result
  --bless  this lint has no fixtures to regenerate
`;

function parseArgs(argv) {
  const args = { root: null, json: null, verbose: false, help: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '--root') {
      const val = argv[i + 1];
      if (val === undefined) {
        args.error = `--root requires a directory argument`;
        return args;
      }
      args.root = val;
      i++;
    } else if (a === '--json') {
      const val = argv[i + 1];
      if (val === undefined) {
        args.error = `--json requires a path argument`;
        return args;
      }
      args.json = val;
      i++;
    } else if (a === '--seed' || a === '--bless') {
      args.error = `${a} is not implemented by check-imports.mjs — see --help (this lint has no seed and no fixtures)`;
      return args;
    } else {
      args.error = `unknown flag: ${a} (see --help)`;
      return args;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Source masking — two variants, see the file header
// ---------------------------------------------------------------------------

/** Blanks `//` and `/* *‍/` comments, preserving every other character
 * (including string/template contents) and every newline, so offsets and
 * line numbers still map 1:1 onto the original source. Used ahead of import
 * extraction, so a specifier inside a real string is still readable but a
 * specifier-looking string inside a comment is not. */
function maskComments(src) {
  let out = '';
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      out += '  ';
      i += 2;
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    // Skip over string/template contents without masking them — a comment
    // delimiter inside a string literal (e.g. a URL containing "//") must
    // not be mistaken for the start of a real comment.
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < n) {
        out += src[i];
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Blanks comments AND string/template-literal contents (delimiters kept as
 * single spaces), preserving newlines. Used for the document/window/
 * performance.now() scan, so prose or log-message text mentioning those
 * words never trips it. Template-literal `${...}` substitutions are masked
 * along with the rest of the template — a known, documented gap (see the
 * report): a forbidden reference written only inside a `${...}` is missed,
 * the same "defeatable" tradeoff 12-testing.md §4.5 explicitly accepts for
 * check-fixed.mjs. */
function maskCommentsAndStrings(src) {
  const commentsOnly = maskComments(src);
  let out = '';
  const n = commentsOnly.length;
  let i = 0;
  while (i < n) {
    const c = commentsOnly[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < n && commentsOnly[i] !== quote) {
        if (commentsOnly[i] === '\\' && i + 1 < n) {
          out += '  ';
          i += 2;
          continue;
        }
        out += commentsOnly[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 1-based line number of `offset` in `src`. */
function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Filesystem walking
// ---------------------------------------------------------------------------

const JS_EXT = new Set(['.js', '.mjs']);

/** Recursively collects every .js/.mjs file under `dir`, sorted, for
 * deterministic output ordering (12-testing.md P2). Returns `[]` for a
 * missing directory — a not-yet-created N-surface root is "nothing to check
 * yet", not an error (this ticket's brief, restating IMPLEMENTATION_PLAN's
 * milestone order: M1-M4 create these directories). */
function collectFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      // A directory queued for the walk can still vanish before it is
      // read — e.g. another suite's scratch directory being torn down
      // concurrently (tests/**/*.test.js run as separate `node --test`
      // workers by default). Nothing left to report; skip it rather than
      // crash the whole run over the race. Matches findDataDirs' own
      // try/catch below.
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && JS_EXT.has(extname(entry.name))) {
        out.push(full);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/** Every directory literally named `data` under `src/`, sorted. Implements
 * 12-testing.md §2.1's "and every `data/` directory" — this also rediscovers
 * `src/world/data/`, which is deduplicated against the explicit root list by
 * the caller (both resolve to the same absolute path). */
function findDataDirs(srcRoot) {
  const out = [];
  if (!existsSync(srcRoot)) return out;
  const stack = [srcRoot];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(d, entry.name);
      if (entry.name === 'data') out.push(full);
      stack.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

const IMPORT_FROM_RE = /\b(?:import|export)\b[^;'"()]*?\bfrom\s*['"]([^'"]+)['"]/g;
const IMPORT_BARE_RE = /\bimport\s*['"]([^'"]+)['"]/g;
const IMPORT_DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every static/dynamic import specifier in `commentsOnlySrc`, each with the
 * character offset of the match (for line-number reporting). May contain
 * duplicates when more than one regex matches the same statement shape
 * differently — harmless, the caller just processes each edge once via its
 * own visited set. */
function extractImportSpecifiers(commentsOnlySrc) {
  const found = [];
  for (const re of [IMPORT_FROM_RE, IMPORT_BARE_RE, IMPORT_DYNAMIC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(commentsOnlySrc))) {
      found.push({ spec: m[1], offset: m.index });
    }
  }
  return found;
}

function isThreeSpecifier(spec) {
  return spec === 'three' || spec.startsWith('three/');
}

/** Resolves a relative import specifier to an absolute file path, trying
 * the bare path, `.js`, `.mjs`, `/index.js`, `/index.mjs` in that order —
 * the same resolution order Node's own ESM loader would apply for this
 * project's extensionless-relative-import style. Bare specifiers (npm
 * packages, Node builtins) are returned as `{ kind: 'bare' }` and are never
 * walked into (see the header — only the 'three' bare specifier itself is
 * ever meaningful here). */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('/')) {
    return { kind: 'bare' };
  }
  const raw = resolve(dirname(fromFile), spec);
  const candidates = extname(raw)
    ? [raw]
    : [`${raw}.js`, `${raw}.mjs`, join(raw, 'index.js'), join(raw, 'index.mjs')];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return { kind: 'resolved', file: c };
  }
  return { kind: 'unresolved' };
}

// ---------------------------------------------------------------------------
// The forbidden-globals scan
// ---------------------------------------------------------------------------

const WINDOW_RE = /\bwindow\s*\./g;
const DOCUMENT_RE = /\bdocument\s*\./g;
const PERF_NOW_RE = /\bperformance\s*\.\s*now\s*\(\s*\)/g;

function scanForbiddenGlobals(maskedSrc) {
  const hits = [];
  for (const [re, label] of [
    [WINDOW_RE, 'window'],
    [DOCUMENT_RE, 'document'],
    [PERF_NOW_RE, 'performance.now()'],
  ]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(maskedSrc))) hits.push({ label, offset: m.index });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The closure walk, one root at a time
// ---------------------------------------------------------------------------

/**
 * @param {string[]} seedFiles - absolute paths, already known to exist.
 * @param {{ checkThree: boolean, checkGlobals: boolean }} rules
 * @param {{ verbose: boolean }} opts
 * @returns {{ violations: object[], filesVisited: number }}
 */
function walkClosure(seedFiles, rules, opts) {
  const violations = [];
  const visited = new Set();
  const queue = seedFiles.map((f) => ({ file: f, chain: [f] }));
  let filesVisited = 0;

  while (queue.length) {
    const { file, chain } = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    filesVisited++;

    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch (err) {
      violations.push({
        kind: 'unreadable',
        file,
        line: 0,
        chain,
        detail: `could not read file: ${err.message}`,
      });
      continue;
    }

    if (opts.verbose) {
      console.log(`[check-imports] visiting ${relative(DISPLAY_ROOT, file)}`);
    }

    const commentsOnly = maskComments(src);
    for (const { spec, offset } of extractImportSpecifiers(commentsOnly)) {
      if (rules.checkThree && isThreeSpecifier(spec)) {
        violations.push({
          kind: 'three-import',
          file,
          line: lineAt(src, offset),
          chain: [...chain],
          detail: `imports '${spec}'`,
        });
        continue;
      }
      const resolved = resolveImport(file, spec);
      if (resolved.kind === 'resolved') {
        if (!visited.has(resolved.file)) {
          queue.push({ file: resolved.file, chain: [...chain, resolved.file] });
        }
      } else if (resolved.kind === 'unresolved') {
        violations.push({
          kind: 'unresolved-import',
          file,
          line: lineAt(src, offset),
          chain: [...chain],
          detail: `cannot resolve relative import '${spec}'`,
        });
      }
      // 'bare' (a non-'three' package or a Node builtin): never walked —
      // ARCHITECTURE.md rule 3 means 'three' is the only real dependency
      // that could ever legitimately appear here, and it is handled above.
    }

    if (rules.checkGlobals) {
      const maskedFull = maskCommentsAndStrings(src);
      for (const { label, offset } of scanForbiddenGlobals(maskedFull)) {
        violations.push({
          kind: 'forbidden-global',
          file,
          line: lineAt(src, offset),
          chain: [...chain],
          detail: `references '${label}'`,
        });
      }
    }
  }

  return { violations, filesVisited };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatChain(chain) {
  return chain.map((f) => relative(DISPLAY_ROOT, f)).join(' -> ');
}

function toFailLine(v) {
  const scope = relative(DISPLAY_ROOT, v.file) + (v.line ? `:${v.line}` : '');
  const chainSuffix = v.chain.length > 1 ? ` (via ${formatChain(v.chain)})` : '';
  const expected = v.kind === 'three-import' ? 'no-three' : v.kind === 'unresolved-import' ? 'resolvable' : v.kind === 'unreadable' ? 'readable' : 'no-dom-global';
  const actual = v.kind === 'three-import' ? 'three' : v.kind === 'forbidden-global' ? v.detail.replace("references '", '').replace("'", '') : 'error';
  return `FAIL  12.N01  ${scope}  ${v.detail}${chainSuffix}  expected=${expected}  actual=${actual}  delta=—`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`check-imports: ${args.error}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(HELP_TEXT);
    process.exitCode = 0;
    return;
  }

  const t0 = Date.now();
  // `--root <dir>` (see the header / HELP_TEXT) makes `<dir>` stand in for
  // the real `<repo>/src/` — every root below is still resolved relative to
  // it, unchanged. `DISPLAY_ROOT` follows it so printed/JSON paths stay
  // short and readable instead of a long walk back out of a temp dir.
  const srcRoot = args.root ? resolve(args.root) : join(REPO_ROOT, 'src');
  DISPLAY_ROOT = args.root ? srcRoot : REPO_ROOT;

  // Required roots, verbatim from 12-testing.md §2.1, plus src/core/,
  // src/physics/ and src/actors/ (see header — all three checked for
  // `three` only, none of the five gameplay roots' full document/window/
  // performance.now() sweep). Each root not existing yet is a NOTE, not a
  // failure.
  const declaredRoots = [
    { path: join(srcRoot, 'combat'), checkThree: true, checkGlobals: true },
    { path: join(srcRoot, 'items'), checkThree: true, checkGlobals: true },
    { path: join(srcRoot, 'skills'), checkThree: true, checkGlobals: true },
    { path: join(srcRoot, 'nav'), checkThree: true, checkGlobals: true },
    { path: join(srcRoot, 'world', 'data'), checkThree: true, checkGlobals: true },
    { path: join(srcRoot, 'core'), checkThree: true, checkGlobals: false },
    { path: join(srcRoot, 'physics'), checkThree: true, checkGlobals: false },
    { path: join(srcRoot, 'actors'), checkThree: true, checkGlobals: false },
  ];

  // "every data/ directory" — auto-discovered, deduped against the explicit
  // list above by absolute path.
  const knownPaths = new Set(declaredRoots.map((r) => r.path));
  for (const dataDir of findDataDirs(srcRoot)) {
    if (!knownPaths.has(dataDir)) {
      declaredRoots.push({ path: dataDir, checkThree: true, checkGlobals: true });
      knownPaths.add(dataDir);
    }
  }

  const notes = [];
  const allViolations = [];
  const visitedFiles = new Set();
  let rootsChecked = 0;

  for (const root of declaredRoots) {
    const label = relative(DISPLAY_ROOT, root.path);
    const seedFiles = collectFiles(root.path);
    if (!existsSync(root.path)) {
      notes.push(`NOTE  12.N01  ${label}  root does not exist yet — nothing to check  expected=—  actual=—  delta=—`);
      continue;
    }
    rootsChecked++;
    const { violations, filesVisited } = walkClosure(seedFiles, root, { verbose: args.verbose });
    for (const v of violations) {
      v.root = label;
      allViolations.push(v);
      visitedFiles.add(v.file);
    }
    for (const f of seedFiles) visitedFiles.add(f);
  }

  // Dedup identical (file, line, kind) findings reached via more than one
  // root/chain — report each real problem once.
  const seenKeys = new Set();
  const violations = [];
  for (const v of allViolations) {
    const key = `${v.kind} ${v.file} ${v.line} ${v.detail}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    violations.push(v);
  }
  violations.sort((a, b) => {
    const sa = relative(DISPLAY_ROOT, a.file);
    const sb = relative(DISPLAY_ROOT, b.file);
    return sa.localeCompare(sb) || a.line - b.line;
  });

  for (const line of notes) console.log(line);
  for (const v of violations) console.error(toFailLine(v));

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(2);
  const exitCode = violations.length > 0 ? 1 : 0;

  console.log(
    `check-imports.mjs  seed=n/a  roots=${rootsChecked}  files=${visitedFiles.size}  elapsed=${elapsedS}s`,
  );
  console.log(`  boundary   ${visitedFiles.size} files scanned   ${violations.length} fail`);
  console.log(`  RESULT: ${exitCode === 0 ? 'PASS' : `FAIL (${violations.length})`}`);

  if (args.json) {
    const payload = {
      tool: 'check-imports.mjs',
      exitCode,
      elapsedMs: Date.now() - t0,
      rootsChecked,
      filesScanned: visitedFiles.size,
      failures: violations.map((v) => ({
        id: '12.N01',
        root: v.root,
        file: relative(DISPLAY_ROOT, v.file),
        line: v.line,
        kind: v.kind,
        detail: v.detail,
        chain: v.chain.map((f) => relative(DISPLAY_ROOT, f)),
      })),
      notes,
    };
    writeFileSync(args.json, JSON.stringify(payload, null, 2));
  }

  process.exitCode = exitCode;
}

main();
