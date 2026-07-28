#!/usr/bin/env node
// tools/check-fixed.mjs
//
// TEST-2 — the `Fixed` lint (docs/spec/12-testing.md §4.5).
//
// ---------------------------------------------------------------------------
// What this checks
// ---------------------------------------------------------------------------
// "`Fixed = N` means calling this from `fixedUpdate` is a determinism bug
// even when it appears to work" — 12-testing.md §4.5. This tool:
//
//   1. Parses every `| Method | Signature | Fixed | Alloc |` table out of
//      docs/spec/02-api-contracts.md and collects the method names whose
//      `Fixed` column is exactly `N` (bold `**N**` normalizes the same way;
//      a property-only row — Signature starting with "property" — is never
//      a call site and is excluded even if it were ever marked `N`, since
//      02-api-contracts.md marks every current `N` property with parens-less
//      access anyway).
//   2. Walks every `.js`/`.mjs` file under `src/` and finds every
//      `fixedUpdate(...) { ... }` METHOD DEFINITION (never a call site like
//      `sys.fixedUpdate(FIXED_DT, ctx)` — see the lookbehind in the regex
//      below).
//   3. Inside each such body, reports:
//        - a call `.<name>(` where `<name>` is in the Fixed=N set,
//        - `performance.now()`, `Date.now()`, `Math.random()`,
//        - `ctx.time.dt` (exactly that dotted path — 12-testing.md §4.5's
//          own wording),
//        - `window.*` / `document.*`.
//
// 12-testing.md §4.5 itself says this is "a static walk over the AST... and
// [is] defeatable by a computed member access — and that is acceptable: it
// catches the accident... and the deliberate case is a review problem."
// This tool is not even a real AST walk (ARCHITECTURE.md rule 3 forbids a
// parser dependency, and Node ships none) — it is a textual heuristic over
// masked source (comments and string/template contents blanked so prose
// never trips it). See "What this does NOT catch" in this ticket's report
// for the exact, honest list of gaps that follows from that.
//
// ---------------------------------------------------------------------------
// The one sanctioned `Math.random()` call (11-flows.md §14.2)
// ---------------------------------------------------------------------------
// `src/main.js`'s `worldSeed` draw is the ONLY legal `Math.random()` call in
// the whole codebase (ARCHITECTURE.md hard rule 4's one documented
// exception) — but it lives in `boot()`, never inside a `fixedUpdate` body,
// so in practice this tool never even reaches it: nothing here scans outside
// a `fixedUpdate(...) { }` span. `SANCTIONED_MATH_RANDOM` below exists as a
// second, narrow, explicit line of defense anyway, in case that call's
// surrounding shape ever changes — it is scoped to exactly one file AND
// requires the exact sanctioning comment (`11-flows.md §14.2`) already
// present on that line in `src/main.js` today, so it can never accidentally
// cover a *different* `Math.random()` call somewhere else in that file, let
// alone in any other file.
//
// ---------------------------------------------------------------------------
// CLI contract (12-testing.md §5.1)
// ---------------------------------------------------------------------------
// Implemented: --json <path>, --verbose, --help, exit codes 0/1/2.
// NOT implemented, on purpose: --seed and --bless — this lint draws no
// randomness (the same source tree always gives the same result) and
// produces no fixtures. Passing either is a hard error (exit 2), so a
// caller is told rather than silently ignored.
//
// Exit codes: 0 every check passed. 1 at least one Fixed=N call (or other
// forbidden read) found in a fixedUpdate body. 2 could not run — today that
// means 02-api-contracts.md is missing or no Method/Signature/Fixed/Alloc
// table could be parsed out of it (the "a data table failed to load"
// case from 12-testing.md §5.1's exit-code table), or bad CLI usage.

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS_PATH = join(REPO_ROOT, 'docs', 'spec', '02-api-contracts.md');

/** The base every printed/JSON path is shown relative to. Defaults to
 * `REPO_ROOT`; `main()` repoints it to `--root <dir>` when given. Mirrors
 * check-imports.mjs's own `DISPLAY_ROOT` — see that file for the reasoning
 * (O-24: test isolation without a long `../../../tmp/...` path prefix). */
let DISPLAY_ROOT = REPO_ROOT;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `check-fixed.mjs — the Fixed=N call-site lint (fixedUpdate bodies only)

Usage:
  node tools/check-fixed.mjs [--root <dir>] [--json <path>] [--verbose] [--help]

Parses the Fixed column out of docs/spec/02-api-contracts.md, walks every
fixedUpdate(...) method body under src/ (or --root <dir>, if given), and
fails on a call to any Fixed=N method, or a read of performance.now(),
Date.now(), Math.random(), ctx.time.dt, window.*, or document.*. See this
file's header for the full contract and its honest limitations.

Options:
  --root <dir>    scan <dir> instead of the real <repo>/src/. Not part of
                  12-testing.md §5.1's common CLI contract — added so a test
                  suite can exercise this tool against a disposable synthetic
                  tree and never touch the real src/ (see this ticket's
                  report, O-24). docs/spec/02-api-contracts.md is always the
                  real one — it is a stable, read-only input, never a
                  scratch path a concurrent test could be racing
  --json <path>   also write a machine-readable result to <path>
  --verbose       print every fixedUpdate body found, not just failures
  --help          print this message and exit 0

Exit codes:
  0  every check passed
  1  at least one forbidden read/call found in a fixedUpdate body
  2  could not run (02-api-contracts.md missing/unparseable, or bad CLI usage)

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
      args.error = `${a} is not implemented by check-fixed.mjs — see --help (this lint has no seed and no fixtures)`;
      return args;
    } else {
      args.error = `unknown flag: ${a} (see --help)`;
      return args;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// 02-api-contracts.md table parsing
// ---------------------------------------------------------------------------

const TABLE_HEADER_RE = /^\|\s*Method\s*\|\s*Signature\s*\|\s*Fixed\s*\|\s*Alloc\s*\|\s*$/;
const TABLE_SEP_RE = /^\|[\s:|-]+\|$/;

/** Splits one `| a | b | c | d |` markdown row into trimmed cells, honouring
 * `\|` as an escaped literal pipe (02-api-contracts.md uses it constantly
 * for union types, e.g. `` `Actor \| null` ``) rather than a column break. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const SENTINEL = '';
  return s
    .replace(/\\\|/g, SENTINEL)
    .split('|')
    .map((c) => c.trim().split(SENTINEL).join('|'));
}

function extractBacktickNames(cell) {
  const names = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(cell))) names.push(m[1]);
  return names;
}

/** `**Y**` / `**N**` -> `Y` / `N`; already-bare values pass through. */
function normalizeFixedCell(cell) {
  return cell.replace(/\*\*/g, '').trim();
}

/** Matches this document's own subsystem section headings, e.g.
 * `## 4. \`physics\`` — verbatim for all sixteen (checked). A `##` heading
 * that ISN'T one of these (there are none at this level in the document
 * today, but the regex is anchored so it would simply not match rather than
 * misfire) leaves `currentSubsystemId` unchanged, which only matters for the
 * "Cross-cutting rules" section at the very end of the file, after every
 * real table has already been consumed — nothing there is a Method/
 * Signature/Fixed/Alloc table, so no row is ever misattributed. */
const SUBSYSTEM_HEADING_RE = /^##\s+\d+\.\s*`([^`]+)`/;

/**
 * Parses every `Method | Signature | Fixed | Alloc` table in `mdText`.
 *
 * @returns {{
 *   fixedNMethods: Set<string>,
 *   perSubsystemFixedN: Map<string, Set<string>>,
 *   tableCount: number,
 *   rowCount: number,
 * }}
 * `fixedNMethods` is the flat union across every subsystem — still needed to
 * build the one combined regex that finds candidate call sites at all (see
 * `buildFixedCallRegex`). `perSubsystemFixedN` is the same information kept
 * apart by owning subsystem id, which is what lets a call site whose
 * receiver is traceable back to a specific `ctx.get('<id>')` be checked
 * against ONLY that subsystem's own Fixed=N set — see `resolveMethodHit`
 * below for why that distinction exists (O-22's `audio.stop()` /
 * `player.stop()` report).
 */
function parseFixedColumn(mdText) {
  const lines = mdText.split('\n');
  const fixedNMethods = new Set();
  const perSubsystemFixedN = new Map();
  let currentSubsystemId = null;
  let tableCount = 0;
  let rowCount = 0;
  let i = 0;
  while (i < lines.length) {
    const headingMatch = SUBSYSTEM_HEADING_RE.exec(lines[i].trim());
    if (headingMatch) {
      currentSubsystemId = headingMatch[1];
      i++;
      continue;
    }
    if (TABLE_HEADER_RE.test(lines[i].trim())) {
      tableCount++;
      i++;
      if (i < lines.length && TABLE_SEP_RE.test(lines[i].trim())) i++;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitRow(lines[i]);
        if (cells.length === 4) {
          const [methodCell, sigCell, fixedCell] = cells;
          const fixedVal = normalizeFixedCell(fixedCell);
          const isProperty = /^property\b/i.test(sigCell.trim());
          if (fixedVal === 'N' && !isProperty) {
            for (const name of extractBacktickNames(methodCell)) {
              fixedNMethods.add(name);
              if (currentSubsystemId) {
                let set = perSubsystemFixedN.get(currentSubsystemId);
                if (!set) {
                  set = new Set();
                  perSubsystemFixedN.set(currentSubsystemId, set);
                }
                set.add(name);
              }
            }
          }
          rowCount++;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return { fixedNMethods, perSubsystemFixedN, tableCount, rowCount };
}

// ---------------------------------------------------------------------------
// Source masking (comments + string/template contents blanked, newlines and
// every other character preserved 1:1 so offsets/line numbers stay valid).
// Deliberately blunt for template literals — the whole `` `...` `` span,
// including any `${...}` substitution, is masked as one string. A forbidden
// call written only inside a `${...}` is therefore missed; documented in
// this ticket's report as a known gap, the same class of "defeatable"
// heuristic miss 12-testing.md §4.5 already accepts for computed access.
// ---------------------------------------------------------------------------

/** Blanks only comments, leaving string/template contents (and their
 * quotes) intact. Used exclusively for `nearestStaticId` below — unlike the
 * forbidden-read scan, finding `static id = '<value>'` needs the quoted
 * value itself, which `maskCommentsAndStrings` deliberately erases. Shares
 * `maskCommentsAndStrings`'s exact comment-stripping rules, so offsets
 * computed against either variant land on the same positions in both (and
 * in the original source) — only what is blanked differs. */
function maskCommentsOnly(src) {
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

function maskCommentsAndStrings(src) {
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
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          out += '  ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
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

function lineAt(src, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Filesystem walking — the WHOLE src/ tree (12-testing.md §4.5: "every
// fixedUpdate body in src/", not scoped to the N-surface roots — any of the
// 16 subsystems, including render/audio/ui, may implement fixedUpdate per
// ARCHITECTURE.md's "Subsystem interface").
// ---------------------------------------------------------------------------

const JS_EXT = new Set(['.js', '.mjs']);

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
      // A directory that existed when it was queued can still vanish before
      // it is walked — this tool scans the WHOLE src/ tree (12-testing.md
      // §4.5), including directories other tools/tests own and may create
      // and delete around it (observed for real: tests/tools/*.test.js's
      // check-imports suite creates/removes src/combat/ as scratch, and
      // `node --test` runs different test files concurrently by default).
      // A vanished directory has nothing left to report — skip it rather
      // than crash the whole run over a TOCTOU race.
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

// ---------------------------------------------------------------------------
// fixedUpdate body extraction
// ---------------------------------------------------------------------------

// Negative lookbehind excludes a preceding '.', word char or '$' — so
// `sys.fixedUpdate(FIXED_DT, ctx)` (a CALL, e.g. src/core/engine.js) never
// matches, only a method-shorthand/function DEFINITION does.
const FIXED_UPDATE_DEF_RE = /(?<![.\w$])fixedUpdate\s*\([^)]*\)\s*\{/g;
const STATIC_ID_RE = /static\s+id\s*=\s*['"]([^'"]+)['"]/g;

function findMatchingBrace(masked, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** @returns {{ bodyStart: number, bodyEnd: number, defOffset: number }[]} */
function findFixedUpdateBodies(masked) {
  const bodies = [];
  FIXED_UPDATE_DEF_RE.lastIndex = 0;
  let m;
  while ((m = FIXED_UPDATE_DEF_RE.exec(masked))) {
    const openBrace = m.index + m[0].length - 1;
    const closeBrace = findMatchingBrace(masked, openBrace);
    if (closeBrace === -1) continue; // unbalanced — malformed source, skip
    bodies.push({ bodyStart: openBrace + 1, bodyEnd: closeBrace, defOffset: m.index });
  }
  return bodies;
}

/** The nearest `static id = '...'` before `offset` in the same file, or
 * `null` if none precedes it — used only to label a failure's scope, never
 * to change what is checked. */
function nearestStaticId(masked, offset) {
  STATIC_ID_RE.lastIndex = 0;
  let best = null;
  let m;
  while ((m = STATIC_ID_RE.exec(masked))) {
    if (m.index < offset) best = m[1];
    else break;
  }
  return best;
}

// ---------------------------------------------------------------------------
// The sanctioned Math.random() call — see the file header.
// ---------------------------------------------------------------------------

const SANCTIONED_MATH_RANDOM = {
  file: join(REPO_ROOT, 'src', 'main.js'),
  lineMarker: '11-flows.md §14.2',
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `ctx.get(id)` / `ctx.peek(id)` / `ctx.has(id)` are the CORE contract
 * (ARCHITECTURE.md "ctx provides", "Get it at runtime:
 * `const combat = ctx.get('combat')`") — not a per-subsystem method at all,
 * and always legal from `fixedUpdate`. `materials.get()` in
 * 02-api-contracts.md §2 happens to share the bare name `get` with
 * `ctx.get`, and without this exclusion EVERY `ctx.get(...)` call in EVERY
 * future fixedUpdate body — the normal, spec-mandated way to reach a
 * dependency at runtime — would misreport as a call to the Fixed=N
 * `materials.get`. Captured by the regex below as receiver + method name and
 * filtered out here whenever the receiver is exactly `ctx`. */
const CTX_CORE_METHODS = new Set(['get', 'peek', 'has']);

/**
 * Finds every `<ident> = ctx.get('<id>')` / `ctx.peek('<id>')` binding in a
 * file — both a local variable (`const render = ctx.get('render')`) and a
 * cached instance field (`this.render = ctx.get('render')`, the `init()`-
 * time pattern every real subsystem uses to keep a peer without re-forking
 * per event) — and returns a `receiverToken -> subsystemId` map.
 *
 * `receiverToken` is deliberately just the trailing identifier: for
 * `this.render = ...` that is `render`, not `this.render`, because the call
 * site this map is matched against (`buildFixedCallRegex`'s capture group)
 * only ever captures the single identifier immediately before the final
 * dot — `this.render.render(ctx)` and `render.render(ctx)` both present as
 * receiver `render` there, and this map treats them the same. That is a
 * whole-FILE, not per-scope, resolution: if a name is bound to two different
 * subsystems in two different classes in one file, this map keeps whichever
 * binding it saw last. This can only make the lint MISS a real violation
 * (attribute a call to the wrong, Fixed=Y-for-that-name subsystem) — never
 * invent one — which is the direction 12-testing.md §4.5 already accepts
 * ("defeatable... and that is acceptable"). One class per file is this
 * codebase's actual shape throughout src/, so the cross-scope case is
 * theoretical today; documented in the report rather than solved with a
 * real scope tracker this tool has no parser to build.
 *
 * @param {string} commentsOnlySrc - comments stripped, quotes intact (see
 *   `maskCommentsOnly`) — the subsystem id has to survive as a real string.
 * @returns {Map<string, string>}
 */
const RECEIVER_BINDING_RE =
  /(?:\bthis\s*\.\s*|\b(?:const|let|var)\s+)([A-Za-z_$][\w$]*)\s*=\s*ctx\s*\.\s*(?:get|peek)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function buildReceiverMap(commentsOnlySrc) {
  const map = new Map();
  RECEIVER_BINDING_RE.lastIndex = 0;
  let m;
  while ((m = RECEIVER_BINDING_RE.exec(commentsOnlySrc))) {
    map.set(m[1], m[2]);
  }
  return map;
}

/** @param {Set<string>} fixedNMethods @returns {RegExp | null} */
function buildFixedCallRegex(fixedNMethods) {
  if (fixedNMethods.size === 0) return null;
  const alt = [...fixedNMethods].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  // The leading '.' is mandatory — this only ever matches member-call form
  // ('a call to any Fixed = N method', 02-api-contracts.md's own wording),
  // never a bare same-named local function call. Group 1 optionally
  // captures a simple identifier immediately before that dot (e.g. `ctx` in
  // `ctx.get(`, or `render` in both `render.render(` and
  // `this.render.render(`); it is `undefined` for a receiver that isn't a
  // simple identifier (e.g. a chained call's return value), and both the
  // `ctx.*` exclusion and the subsystem-narrowing below then simply never
  // fire for that call — the conservative (never-under-report) direction to
  // be wrong in. Group 2: the matched Fixed=N method name.
  return new RegExp(`(?:([A-Za-z_$][\\w$]*)\\s*)?\\.\\s*(${alt})\\b\\s*\\(`, 'g');
}

/**
 * Decides whether a candidate `.name(` match (already known to be Fixed=N
 * for AT LEAST ONE subsystem, or `buildFixedCallRegex` would never have
 * matched it) is actually a violation, once the receiver is known.
 *
 * The false-positive PLYR-1 hit (O-22): `audio.stop()` is Fixed=N, but
 * `player.stop()` is Fixed=Y, and a flat name-only set cannot tell them
 * apart — every `player.stop()` in every future fixedUpdate would misreport.
 * When the receiver traces back to a `ctx.get('<id>')` binding (via
 * `receiverMap`), this checks `<id>`'s OWN Fixed column for `name` instead
 * of the flat union: `<id>` not marking `name` as Fixed=N — even if some
 * other subsystem does — means this specific call is fine.
 *
 * An unresolvable receiver (not in `receiverMap` — a chained call, a
 * parameter, a receiver bound outside a traceable `ctx.get`/`peek` pattern)
 * falls back to the flat, name-only rule: flag it. That is the "catches the
 * accident" default 12-testing.md §4.5 already signs off on; the subsystem
 * narrowing only ever makes this MORE precise for the traceable case, never
 * less strict for the untraceable one.
 *
 * @param {string | undefined} receiver
 * @param {string} name
 * @param {Map<string, string>} receiverMap
 * @param {Map<string, Set<string>>} perSubsystemFixedN
 * @returns {boolean} true if this is a real violation
 */
function resolveMethodHit(receiver, name, receiverMap, perSubsystemFixedN) {
  if (receiver === 'ctx' && CTX_CORE_METHODS.has(name)) return false;
  const subsystemId = receiver ? receiverMap.get(receiver) : undefined;
  if (subsystemId) {
    const set = perSubsystemFixedN.get(subsystemId);
    return !!set && set.has(name);
  }
  return true; // unresolved receiver — conservative default, see above
}

/** Scans one fixedUpdate body's masked text for every forbidden read/call.
 * Offsets are relative to `bodyText` (add `bodyStart` for the file-absolute
 * offset). */
function scanBody(bodyText, fixedCallRegex, perSubsystemFixedN, receiverMap) {
  const hits = [];

  if (fixedCallRegex) {
    fixedCallRegex.lastIndex = 0;
    let m;
    while ((m = fixedCallRegex.exec(bodyText))) {
      const receiver = m[1];
      const name = m[2];
      if (!resolveMethodHit(receiver, name, receiverMap, perSubsystemFixedN)) continue;
      // Offset the match forward past the captured receiver (if any), so the
      // reported position points at the method name, not the receiver.
      const nameOffset = receiver ? m.index + m[0].indexOf(name, receiver.length) : m.index;
      hits.push({
        offset: nameOffset,
        kind: 'fixed-call',
        detail: `calls '${name}()' (Fixed=N per 02-api-contracts.md)`,
        actual: `${name}()`,
      });
    }
  }

  const SIMPLE_PATTERNS = [
    [/\bperformance\s*\.\s*now\s*\(\s*\)/g, 'clock-read', "reads 'performance.now()'", 'performance.now()'],
    [/\bDate\s*\.\s*now\s*\(\s*\)/g, 'clock-read', "reads 'Date.now()'", 'Date.now()'],
    [/\bMath\s*\.\s*random\s*\(\s*\)/g, 'random-read', "calls 'Math.random()'", 'Math.random()'],
    [/\bctx\s*\.\s*time\s*\.\s*dt\b/g, 'raw-dt-read', "reads 'ctx.time.dt'", 'ctx.time.dt'],
    [/\bwindow\s*\./g, 'dom-read', "references 'window'", 'window'],
    [/\bdocument\s*\./g, 'dom-read', "references 'document'", 'document'],
  ];
  for (const [re, kind, detail, actual] of SIMPLE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(bodyText))) hits.push({ offset: m.index, kind, detail, actual });
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function toFailLine(v) {
  const scope = `${relative(DISPLAY_ROOT, v.file)}:${v.line}`;
  const label = v.classId ? `'${v.classId}'.fixedUpdate()` : 'fixedUpdate()';
  return `FAIL  12.F01  ${scope}  ${label} ${v.detail}  expected=not-in-fixedUpdate  actual=${v.actual}  delta=—`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(`check-fixed: ${args.error}`);
    process.exitCode = 2;
    return;
  }
  if (args.help) {
    console.log(HELP_TEXT);
    process.exitCode = 0;
    return;
  }

  const t0 = Date.now();

  // 02-api-contracts.md is always the REAL one, even under --root — see
  // HELP_TEXT: it is a stable, read-only input no concurrent test ever
  // mutates, so there is nothing for --root to isolate it from.
  let contractsText;
  try {
    contractsText = readFileSync(CONTRACTS_PATH, 'utf8');
  } catch (err) {
    console.error(`check-fixed: could not read ${relative(REPO_ROOT, CONTRACTS_PATH)}: ${err.message}`);
    process.exitCode = 2;
    return;
  }

  const { fixedNMethods, perSubsystemFixedN, tableCount, rowCount } = parseFixedColumn(contractsText);
  if (tableCount === 0) {
    console.error(
      `check-fixed: found zero '| Method | Signature | Fixed | Alloc |' tables in ${relative(REPO_ROOT, CONTRACTS_PATH)} — the doc structure changed and this tool's parser needs updating`,
    );
    process.exitCode = 2;
    return;
  }

  const fixedCallRegex = buildFixedCallRegex(fixedNMethods);
  // `--root <dir>` (see the header / HELP_TEXT) walks `<dir>` instead of the
  // real `<repo>/src/`. `DISPLAY_ROOT` follows it so printed/JSON paths stay
  // short instead of a long walk back out of a temp dir.
  const srcRoot = args.root ? resolve(args.root) : join(REPO_ROOT, 'src');
  DISPLAY_ROOT = args.root ? srcRoot : REPO_ROOT;
  const files = collectFiles(srcRoot);

  const violations = [];
  let bodiesFound = 0;

  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const masked = maskCommentsAndStrings(src);
    const commentsOnly = maskCommentsOnly(src); // preserves quotes — see nearestStaticId / buildReceiverMap
    const receiverMap = buildReceiverMap(commentsOnly);
    const bodies = findFixedUpdateBodies(masked);
    for (const body of bodies) {
      bodiesFound++;
      const classId = nearestStaticId(commentsOnly, body.defOffset);
      if (args.verbose) {
        console.log(
          `[check-fixed] ${relative(DISPLAY_ROOT, file)}:${lineAt(src, body.defOffset)} fixedUpdate() of ${classId ? `'${classId}'` : '(no static id found)'}`,
        );
      }
      const bodyText = masked.slice(body.bodyStart, body.bodyEnd);
      for (const hit of scanBody(bodyText, fixedCallRegex, perSubsystemFixedN, receiverMap)) {
        const absOffset = body.bodyStart + hit.offset;
        const line = lineAt(src, absOffset);

        if (hit.kind === 'random-read' && file === SANCTIONED_MATH_RANDOM.file) {
          const lineText = src.split('\n')[line - 1] || '';
          if (lineText.includes(SANCTIONED_MATH_RANDOM.lineMarker)) continue; // the one sanctioned call
        }

        violations.push({
          file,
          line,
          classId,
          kind: hit.kind,
          detail: hit.detail,
          actual: hit.actual,
        });
      }
    }
  }

  violations.sort((a, b) => {
    const sa = relative(DISPLAY_ROOT, a.file);
    const sb = relative(DISPLAY_ROOT, b.file);
    return sa.localeCompare(sb) || a.line - b.line;
  });

  for (const v of violations) console.error(toFailLine(v));

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(2);
  const exitCode = violations.length > 0 ? 1 : 0;

  console.log(
    `check-fixed.mjs  seed=n/a  contracts=${fixedNMethods.size} Fixed=N methods (${tableCount} tables, ${rowCount} rows)  files=${files.length}  bodies=${bodiesFound}  elapsed=${elapsedS}s`,
  );
  console.log(`  fixedUpdate-reads   ${bodiesFound} bodies scanned   ${violations.length} fail`);
  console.log(`  RESULT: ${exitCode === 0 ? 'PASS' : `FAIL (${violations.length})`}`);

  if (args.json) {
    const payload = {
      tool: 'check-fixed.mjs',
      exitCode,
      elapsedMs: Date.now() - t0,
      fixedNMethodCount: fixedNMethods.size,
      filesScanned: files.length,
      fixedUpdateBodiesFound: bodiesFound,
      failures: violations.map((v) => ({
        id: '12.F01',
        file: relative(DISPLAY_ROOT, v.file),
        line: v.line,
        classId: v.classId,
        kind: v.kind,
        detail: v.detail,
        actual: v.actual,
      })),
    };
    writeFileSync(args.json, JSON.stringify(payload, null, 2));
  }

  process.exitCode = exitCode;
}

main();
