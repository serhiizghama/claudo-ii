# 12 — Testing, Harnesses and CI

**Owner:** the lead (`tests/`, `tools/`, `.github/workflows/`)
**Consumers:** every subsystem — each owns its own assertions, none owns the runner
**Status:** specification, binding. The gates here are the definition of "done".

Eleven specifications describe what the game *is*. This one describes how we
find out whether the code agrees with them.

It owns three things and nothing else: **where a test runs**, **what a failure
looks like**, and **which gate blocks which milestone**. It invents no
assertion. Every check named here is already specified by the document that owns
the subject — `05-skills.md` §13 owns the balance assertions, `07-world-gen.md`
§11 owns the map invariants, `09-ui.md` §17 owns the UI steps — and this
document's job is to say who runs them, in what order, against which fixtures,
and what happens when one goes red.

**Binding documents.** This document expands, and never contradicts:

| Document | What it binds here |
|---|---|
| `ARCHITECTURE.md` | the determinism contract, `npm run build` + `capture.mjs` as the minimum bar, the no-new-dependency rule |
| `01-data-model.md` §10 | the save schema, its invariants, and the migration rules `save-fuzz` exercises |
| `02-api-contracts.md` | `Fixed`/`Alloc` columns — every one of them is a testable claim |
| `03-combat-math.md` §§6, 11–12 | the worked examples E1–E14, which are unit tests in all but name |
| `04-items.md` §10 | the loot-distribution gates |
| `05-skills.md` §13 | the per-skill and per-build gates |
| `06-monsters-ai.md` §12 | the AI and encounter gates |
| `07-world-gen.md` §11 | the generator invariants |
| `08-characters-visual.md` §11 | the rig, silhouette and animation gates |
| `09-ui.md` §17 | the UI acceptance steps |
| `10-audio.md` §14 | the offline audio gate and the live probe |
| `11-flows.md` §14 | the determinism checkpoints |
| `13-progression-lore.md` §12 | the progression and quest gates |

---

## Table of contents

1. [Principles](#1-principles)
2. [The three surfaces](#2-the-three-surfaces)
3. [Assertion identity](#3-assertion-identity)
4. [Unit tests](#4-unit-tests)
5. [The harnesses](#5-the-harnesses)
6. [Fixtures](#6-fixtures)
7. [Determinism testing](#7-determinism-testing)
8. [Performance gates](#8-performance-gates)
9. [The pixel gate](#9-the-pixel-gate)
10. [CI](#10-ci)
11. [Milestone gates](#11-milestone-gates)
12. [Failure output](#12-failure-output)
13. [What we deliberately do not test](#13-what-we-deliberately-do-not-test)
14. [Implementation order](#14-implementation-order)
15. [Deviations and decisions owned by this document](#15-deviations-and-decisions-owned-by-this-document)

---

## 1. Principles

| # | Principle | Consequence |
|---|---|---|
| P1 | **Gameplay is testable without a browser.** `combat`, `items`, `skills`, `nav` and the map generator import nothing from `three` and touch no DOM. | The expensive checks — 200 000 loot rolls, 4 158 builds, 5 400 layouts — run in Node in seconds, on every push, with no GPU. This is an architectural requirement (`ARCHITECTURE.md` rule 9), not a convenience. |
| P2 | **There are no flaky tests, only non-deterministic code.** Every input is seeded: RNG, the fixed step, the input script. | **Zero retries. Ever.** A test that passes on the second run is a determinism bug and is triaged as one. A CI job that retries hides exactly the class of defect this project's harnesses exist to catch. |
| P3 | **A gate that cannot fail is not a gate.** | Every check names the number it compares against and the document that owns that number. A check whose threshold is "looks fine" is not written. |
| P4 | **The failure output is the product.** | A red gate prints the seed, the repro command and the smallest reproduction it can construct. `tools/mapgen.mjs` re-runs a failing seed with per-stage instrumentation to name the stage that broke it; that is the standard, not the exception. |
| P5 | **Fixtures are records, not expectations.** | A committed fixture is what shipped. Regenerating one is a deliberate act with a flag (`--bless`), a diff in the review and a sentence in the commit message. Never a silent overwrite. |
| P6 | **No test framework.** | `node --test` is in the runtime. Jest, Vitest and Mocha are three more dependencies, three more config files and one more thing that can disagree with the build. `ARCHITECTURE.md` rule 3 already forbids them. |
| P7 | **Every `Fixed` and `Alloc` column in `02-api-contracts.md` is a claim under test.** | `Alloc = no` is checked by an allocation probe, not by inspection. `Fixed = N` is checked by a call-site lint. Both are cheap and both catch a whole class of regression that reading cannot. |

---

## 2. The three surfaces

Everything runs on exactly one of three surfaces. The surface decides the cost,
the CI stage and what a failure can mean.

| Surface | What runs | Needs | Wall clock (full) |
|---|---|---|---|
| **N — Node** | unit tests, `lootsim`, `balance`, `mapgen`, `save-fuzz`, `audio-bench`, the API lints | `node` only. No `three`, no DOM, no GPU | **≤ 90 s** |
| **B — Headless browser** | `capture`, `baseline`, `profile`, `playtest`, `audio-probe`, `rigcheck`, `mannequin`, `equipdiff`, `silhouette`, `readability` | Playwright + a GPU-backed headless Chromium | **≤ 6 min** |
| **P — Pixel** | `imagediff` over the `baseline` output | the B surface having run | **≤ 20 s** |

### 2.1 The N/B boundary is load-bearing

A test on the N surface can run 5 400 map layouts in 12 seconds because it never
builds a mesh. The moment a gameplay module imports `three` — even for a
`Vector3` — that whole class of test dies, and it dies quietly: the import
succeeds in the browser and the harness is simply never written.

The boundary is therefore enforced mechanically, not by review:

```
node tools/check-imports.mjs
```

walks `src/combat/`, `src/items/`, `src/skills/`, `src/nav/`, `src/world/data/`
and every `data/` directory, resolves each `import` transitively, and exits
non-zero if the closure reaches `three`, `document`, `window` or
`performance.now()`. It runs first in CI because every other N-surface job
depends on it holding. `02-api-contracts.md`'s note that `Vec3` means a plain
`{x, y, z}` "at any boundary between subsystems" is the same rule seen from the
API side.

### 2.2 What the B surface is allowed to assert

Only things a frame can show: pixels, timings, node counts, console output and
the absence of exceptions. A B-surface test **must not** be the only proof of a
gameplay rule — if a rule can be checked in Node it is checked in Node, and the
browser test exists to prove the rule survived contact with the renderer.

---

## 3. Assertion identity

Eleven documents specify assertion sets and five of them independently chose the
prefix `S`, four chose `B`, three chose `T` and two chose `L`. `05-skills.md`
§13.1 has `S1…S12`; `06-monsters-ai.md` §12 has `S1…S17`. `05` has `B1…B11`;
`11-flows.md` §14.8 has `B1…B13`; `04-items.md` §10 has `B0…B6`.

**Every assertion id is namespaced by its owning document number.** The full id
is `<doc>.<id>` and that is what appears in output, in fixture names, in CI logs
and in a commit message:

```
05.B07     the build-DPS spread gate           05-skills.md §13.2
06.S10     the pack-alert propagation check    06-monsters-ai.md §12
07.I02     chest reachability                  07-world-gen.md §11
11.B09     the fixed-step ordering checkpoint  11-flows.md §14.8
```

The unqualified form is legal inside the owning document, where it is
unambiguous, and nowhere else. Numeric parts are zero-padded to two digits so
that a sorted log reads in order.

Reserved letters, so that a new set does not collide:

| Letter | Meaning | Owners today |
|---|---|---|
| `S` | per-subject static checks (one skill, one monster, one base) | 05, 06 |
| `B` | per-build / per-batch behavioural checks | 04, 05, 11 |
| `I` | generator invariants | 07 |
| `T` | timing, transitions, tick order | 06, 07, 08, 11 |
| `L` | distribution and loot checks | 04, 10 |
| `U` | UI acceptance steps | 09 |
| `G` | economy and gold | 04 |
| `MB` | monster-balance sweeps | 06 |
| `P` | progression | 13 |
| `C` | core/engine requirements | 02, 11 |
| `E` | worked examples reproduced exactly | 03 |
| `D` | determinism | 12 (this document, §7) |
| `A` | allocation and API-contract lints | 12 (this document, §4.4) |

---

## 4. Unit tests

### 4.1 Runner and layout

```
tests/
  combat/        pipeline.test.js, tohit.test.js, status.test.js, examples.test.js
  items/         roll.test.js, affix.test.js, container.test.js, value.test.js
  skills/        registry.test.js, cost.test.js, synergy.test.js
  nav/           grid.test.js, astar.test.js, flow.test.js
  world/         layout.test.js
  save/          schema.test.js, migrate.test.js
  core/          rng.test.js, registry.test.js, events.test.js
  fixtures/      see §6
  helpers/       actor.js, seed.js, alloc.js
```

```
node --test tests/                 # everything
node --test tests/combat/          # one subsystem
node --test --test-name-pattern='E13' tests/
```

`node --test` is the whole runner. No transform, no config file, no globals:
each file imports what it tests and uses `node:assert/strict`. A test file that
needs a live `ctx` builds a stub from `tests/helpers/`, never a real engine.

### 4.2 The worked examples are the spine

`03-combat-math.md` §12 carries fourteen fully worked examples, E1–E14, each
with every intermediate value printed. They transcribe directly:

```js
test('03.E13 — level-10 Runeblade imbued hit', () => {
  const { source, target } = fixtures.e13();
  const packet = combat.buildAttackPacket(source, 'rune_strike', 5);
  const result = combat.resolve(packet, target);
  assert.equal(result.total, 39);
  assert.equal(round4(result.manaReturned), 1.7155);
  assert.equal(result.resonanceGained, 1);
});
```

These are the highest-value tests in the project and the cheapest to write,
because the expected values were derived before any code existed. **Every one of
E1–E14 is a test before `combat` is considered complete**, and each asserts the
*intermediate* values the document prints, not only the total — a pipeline that
reaches 39 by two compensating errors passes a total-only check and fails this
one.

The same treatment applies to every other document's worked arithmetic:
`04-items.md` §1.8's two damage ladders, `05-skills.md` §11's three resource
simulations (to ±2 %), `13-progression-lore.md` §1.4's XP table.

### 4.3 Coverage, and what it is not

There is no line-coverage threshold and no coverage gate. A `%` target rewards
tests that execute code without asserting anything about it, which is the
opposite of what this project needs from a suite whose whole purpose is to pin
down numbers.

The coverage rule is **structural**, and it is checkable:

| Rule | Checked by |
|---|---|
| Every public method in `02-api-contracts.md` is called by at least one test | `tests/core/api-coverage.test.js` parses the tables from the markdown and asserts the set of called names covers them |
| Every skill in the registry has its L1 and L20 rows asserted | `05.S01`/`05.S02`, over all 30 |
| Every affix has its range asserted at its `alvl` and at `alvl + 20` | `04.S*`, over all 117 |
| Every migration path `vN → vN+1` has a fixture | `save-fuzz`, §5.4 |
| Every event in `ARCHITECTURE.md`'s table has an emitter test and a listener test | `tests/core/events.test.js` |

Parsing the contract tables out of the markdown is deliberate. It means adding a
row to `02-api-contracts.md` without a test fails the suite, which is the
enforcement mechanism that document's "adding a public method means adding a row
here in the same commit" rule has otherwise been missing.

### 4.4 Allocation probes — the `A` set

`Alloc = no` is a promise about the garbage collector, and reading code does not
verify it. Node exposes what we need:

```js
function allocatedBytes(fn, iterations = 10_000) {
  fn();                                     // warm up, let the shapes settle
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i++) fn();
  const after = process.memoryUsage().heapUsed;
  return (after - before) / iterations;     // bytes per call
}
```

Run with `node --expose-gc`. The gate:

| id | Assertion | Threshold |
|---|---|---|
| `12.A01` | Every `Alloc = no` method allocates | `< 1 byte/call` net, or exactly one 16-byte boxed return — see below |
| `12.A02` | A full `fixedUpdate` step with 25 monsters in contact allocates | `< 1 byte/step` after warm-up |
| `12.A03` | `EventBus.emit` with 8 handlers allocates | `0 bytes` — this is `ARCHITECTURE.md`'s C-4 |
| `12.A04` | A pooled record is never returned twice without a release | pool double-release assert, dev builds |
| `12.A05` | `combat.resolve` over a 12-target `flame_wave` allocates | `< 1 byte/call` |

Two things about `12.A01`'s threshold, both learned the hard way (O-135…O-137).

**Measure net.** `allocatedBytes` divides a whole round's heap delta by `N`, so
a cost paid once per round is reported per-call at `F / N` — and raising `N`
dilutes it until it disappears. Use `allocatedBytesNet` /
`assertAllocationFreeNet` (`tests/helpers/alloc.js`): same measurement minus a
no-op baseline taken in the same round, after a real warm-up (a single call
does not tier the function up, and an un-tiered reading is bimodal). The
`< 1 byte` figure is unchanged; it now applies to the quantity this line always
meant.

**One boxed return is exempt, nothing more.** Per `02-api-contracts.md`'s
boxed-return carve-out, a method returning a fractional `number` may cost one
16-byte `HeapNumber` at the call boundary. Such a method is asserted at exactly
16 B/call rather than under 1 — pinned, not thresholded, so that both fixing it
and regressing it fail loudly.

`12.A02` is the one that matters. It is also the one that will fail most often,
because a per-frame allocation is easy to add and invisible until a hitch shows
up in `profile.mjs` three weeks later.

### 4.5 The `Fixed` lint

`Fixed = N` means "calling this from `fixedUpdate` is a determinism bug even
when it appears to work". `tools/check-fixed.mjs` parses the `Fixed` column out
of `02-api-contracts.md`, walks every `fixedUpdate` body in `src/`, and reports
a call to any `Fixed = N` method, plus any read of `performance.now()`,
`Date.now()`, `Math.random()`, `ctx.time.dt`, `window.*` or `document.*`.

It is a static walk over the AST, so it is defeatable by a computed member
access — and that is acceptable: it catches the accident, which is the whole
population of real occurrences, and the deliberate case is a review problem.

---

## 5. The harnesses

Nine tools, four of them ported from the source project and five written for
this game. Each has one owner document, one exit contract and one output format.

| Tool | Surface | Owner doc | Asserts | Budget |
|---|---|---|---|---|
| `tools/lootsim.mjs` | N | `04-items.md` §10 | rarity, affix and ilvl distributions over 200 000 drops | 15 s |
| `tools/balance.mjs` | N | `05-skills.md` §13, `06-monsters-ai.md` §12 | TTK, DPS spread, resource economies, 4 158 builds | 25 s |
| `tools/mapgen.mjs` | N | `07-world-gen.md` §11 | connectivity, reachability, density over 5 400 layouts | 25 s |
| `tools/save-fuzz.mjs` | N | `01-data-model.md` §10 | every migration path, every invariant, corrupt-input handling | 10 s |
| `tools/audio-bench.mjs` | N | `10-audio.md` §14 | every voice's node count, length and peak, offline | 20 s |
| `tools/capture.mjs` | B | this document | one named shot renders and is not blank | 8 s |
| `tools/baseline.mjs` | B | this document | the full shot set, each in an isolated page | 3 min |
| `tools/profile.mjs` | B | §8 | frame time p50/p95/p99 with hitch attribution | 90 s |
| `tools/playtest.mjs` | B | §11 | a scripted run completes without dying or wedging | 2 min |
| `tools/imagediff.mjs` | P | §9 | pixel equality against the blessed set | 15 s |

Five smaller B-surface gates are owned by `08-characters-visual.md` and
`09-ui.md` and run inside the `baseline` job rather than as separate CI stages:
`rigcheck.mjs` (bone counts, bind poses, no NaN transforms), `silhouette.mjs`
(archetype distinguishability at 62 px), `mannequin.mjs` (≥ 12 % of covered
pixels change over 0.50 s), `equipdiff.mjs` (four visual equipment slots
actually change the mesh), `readability.mjs` (player contrast in `dense-combat`).

### 5.1 Common CLI contract

Every tool, without exception:

```
--seed <hex>        override the fixed seed. Default: the tool's own constant
--json <path>       machine-readable result alongside the human output
--verbose           per-case detail
--bless             regenerate this tool's fixtures (§6). Never combined with CI
--help
```

Exit codes are uniform, so a CI step never needs to parse output to decide:

| Code | Meaning |
|---|---|
| `0` | every assertion passed |
| `1` | at least one assertion failed |
| `2` | could not run — a data table failed to load, a fixture is missing |
| `3` | non-determinism detected between two runs at the same seed |
| `4` | a budget was exceeded (time, memory, allocation) but no assertion failed |

Code `3` is separate from `1` on purpose. A determinism break is not one more
red check: it invalidates every other result in the same run, and CI reports it
as such rather than burying it in a list.

### 5.2 `tools/balance.mjs`

The largest harness, and the one that decides whether the game is playable.
`05-skills.md` §13 owns its assertions (`05.S01`–`05.S12` per skill,
`05.B01`–`05.B11` per build); `06-monsters-ai.md` §12 owns `06.MB01`–`06.MB20`.

```
node tools/balance.mjs                      # everything, exit 1 on any failure
node tools/balance.mjs --skills             # per-skill only
node tools/balance.mjs --builds             # the nine reference builds
node tools/balance.mjs --sweep              # the 4 158-build sweep
node tools/balance.mjs --monsters           # the monster and encounter set
node tools/balance.mjs --progression        # 13-progression-lore.md §1
node tools/balance.mjs --build R-B --trace  # one build, every intermediate value
```

`--trace` prints the pipeline step by step in the format of `03-combat-math.md`
§12's worked examples, which is what makes a failure diagnosable in one run
rather than three.

The sweep is every allocation that puts ≥ 15 points into one skill and spreads
the remainder over at most two others — 1 386 builds per class. `05.B07` is
evaluated over the sweep and not over the nine hand-written builds, so a
degenerate combination cannot hide by not being written down.

**Notes versus failures.** Some build shapes are legibly bad rather than broken:
a Runeblade with no `blade_seal` has no Resonance sink by construction, and a
`blade_seal 15` with no `resonance_circuit` discards 40 % of what it generates
(`05-skills.md` §12.5). These print as `NOTE` lines, are counted in the summary
and never change the exit code. A gate that fails on a player's bad build choice
is a gate that will be disabled within a month.

### 5.3 `tools/lootsim.mjs`

200 000 drops per configuration, against the ladders in `04-items.md` §§5–7.
Configurations: three difficulties × three monster ranks × four Magic Find
values (0, 50, 150, 400). Each cell asserts the rarity split within its stated
tolerance, the affix-count distribution, the ilvl distribution, and that no
affix appears on a base its `requiresGroups` forbid.

The draw-order contract of `02-api-contracts.md` § Determinism is what makes the
histogram reproducible; `12.D03` (§7) asserts the tool reproduces its own
histogram byte-for-byte across two runs at the same seed.

The economy checks (`04.G01`, `04.G02`) run in the same pass because they need
the same 200 000 drops: gold per zone clear, and the ledger at clvl 5 / 15 / 28.

### 5.4 `tools/save-fuzz.mjs`

Three jobs, in order:

1. **Round-trip.** Generate 5 000 characters across every legal combination of
   class, level, allocation shape, container occupancy and quest state; write,
   read back, and assert deep equality after `rebuildCache`.
2. **Migration.** Every committed fixture of every schema version is loaded by
   the current build and must pass all 17 invariants of `01-data-model.md`
   §10.3. A version with no fixture fails the run — that is how the "never bump
   `SCHEMA_VERSION` without a fixture" rule is enforced rather than remembered.
3. **Corruption.** For each of 2 000 saves: truncate at a random byte, flip a
   random bit, delete a random key, and set a random numeric field to `NaN`,
   `Infinity`, `-1` and `1e308`. Every one of the 8 000 mutants must be
   **quarantined, not loaded, and never crash the boot**. A mutant that loads
   and produces an invalid character is the worst outcome and is reported
   separately from one that crashes.

### 5.5 `tools/mapgen.mjs`

5 400 layouts — three zones × 200 world seeds × three run indices — against
`07-world-gen.md` §11's `I1`–`I9`. It rasterises the nav grid from
`world.staticFootprints` with no `physics` instance, which is the reason that
property exists.

On a failure it writes three artefacts per bad seed (a region PNG, the full
layout JSON, an ASCII macro-cell map), re-runs the seed with per-stage
instrumentation, and names the last generator stage that changed the failing
quantity. The `cause:` line in its output is not decoration; without it a
one-in-two-thousand connectivity failure is undiagnosable.

### 5.6 `tools/playtest.mjs`

The only harness that plays the game. A scripted input sequence — not a bot,
not an AI — drives a real browser build through a full descent at a fixed seed:
enter the Wastes, clear to the exit, descend, reach the Altar, kill Molgrim,
take the reward, return to town.

| id | Assertion |
|---|---|
| `12.B01` | The run completes inside 12 minutes of simulated time |
| `12.B02` | The character never dies (the script plays conservatively) |
| `12.B03` | No frame exceeds 50 ms |
| `12.B04` | Zero uncaught exceptions, zero `console.error` |
| `12.B05` | Zero shader compilations after the first frame |
| `12.B06` | The quest reaches state `complete` and the reward is in the inventory |
| `12.B07` | Two runs at the same seed produce identical end-state hashes |
| `12.B08` | Peak heap growth over the run is `< 40 MB`, and the heap after a return to town is within 8 MB of the heap before the descent |

`12.B08` is the leak gate. A zone transition that fails to dispose its
geometry passes every other check in this document and kills a session after
four descents, which is precisely one act.

---

## 6. Fixtures

```
tests/fixtures/
  saves/            v1/*.json … one per schema version, per class, per stage
  loot/             histogram-<config>.json          blessed distributions
  mapgen/           hashes.json                      11 layout hashes
  balance/          builds.json                      the nine reference builds
  audio/            nodecounts.json                  per-id node and length
  shots/            *.png                            the pixel baseline
```

Rules:

1. A fixture is **committed** and is the record of what shipped.
2. A fixture is regenerated only by its own tool with `--bless`, never by hand
   and never by a CI job.
3. A `--bless` diff is reviewed as a **content change**, because that is what it
   is. "Regenerated fixtures" alone is not an acceptable commit message; the
   message names the number that moved and why.
4. A save fixture is **never edited**, not even to fix a typo. Editing it
   destroys the evidence that the migration path from that version works.
5. Binary fixtures (`shots/`) are stored at 1280×720 to keep the repository
   small; the pixel gate runs at that resolution and `profile.mjs` runs at
   1080p, so the two are not the same job.

Total committed fixture weight is budgeted at **≤ 12 MB**, of which the shot
baseline is ~9 MB. When it is exceeded, shots are dropped from the baseline set
before anything else — a smaller set of well-chosen shots catches more than a
large set nobody looks at.

---

## 7. Determinism testing

The determinism contract is `ARCHITECTURE.md`'s and the per-stream checkpoints
are `11-flows.md` §14's. This section owns the tests.

| id | Assertion | How |
|---|---|---|
| `12.D01` | Two `balance.mjs` runs at one seed produce byte-identical JSON | run twice in-process, compare |
| `12.D02` | Two `mapgen.mjs` runs at one seed produce identical layout hashes | as above |
| `12.D03` | Two `lootsim.mjs` runs at one seed produce identical histograms | as above |
| `12.D04` | A 600-step simulation replays to an identical state hash from a saved input script | `tests/core/replay.test.js` |
| `12.D05` | Each subsystem's RNG stream advances by the same count in both runs | per-stream draw counters, compared per fixed step |
| `12.D06` | No subsystem draws from another's stream | each fork is instrumented with an owner tag in dev builds |
| `12.D07` | A frame that runs 1, 2 or 6 fixed steps produces the same state after the same *number of steps* | drive the loop with three different `rawDt` schedules |
| `12.D08` | The `items` draw order matches the twelve-step contract | the stream records a tag per draw; the sequence is compared to the contract |

`12.D07` is the one that catches the classic bug: a system that integrates
against `dt` instead of `h` looks correct at a steady 60 fps and diverges the
first time a frame is slow. The test schedules the same 600 steps as
600 × 1, 300 × 2 and 100 × 6 and requires the three end states to be equal.

**The state hash.** A stable FNV-1a over a canonical projection of the world:
every actor's `id, x, z, life, mana, secondary, state, actionSeq`, every ground
item's `uid, x, z`, the RNG position of each stream, and `ctx.time.step`.
Presentation state is excluded by construction — it is not simulation and it is
allowed to differ.

---

## 8. Performance gates

Targets are `IMPLEMENTATION_PLAN.md` §5's; this section says how they are
measured and when they block.

| id | Gate | Threshold | Tool |
|---|---|---|---|
| `12.P01` | Frame time, 1080p DPR1, `dense-combat` shot | p50 ≤ 16.7 ms, p95 ≤ 20 ms, p99 ≤ 28 ms | `profile.mjs` |
| `12.P02` | Frame time, 1080p DPR2, Apple silicon | p50 ≤ 22 ms | `profile.mjs` |
| `12.P03` | Draw calls | ≤ 150 | `profile.mjs` |
| `12.P04` | Triangles | ≤ 2.5 M | `profile.mjs` |
| `12.P05` | Shader compilations after the first frame | **0** | `profile.mjs`, `playtest.mjs` |
| `12.P06` | Boot to first interactive frame | ≤ 4.0 s | `profile.mjs --boot` |
| `12.P07` | `ui` cost in `lateUpdate` at 1080p | ≤ 1.0 ms | `profile.mjs` |
| `12.P08` | `nav.rebuild` on a 96×96 m zone | ≤ 3.0 ms | `mapgen.mjs` (N surface) |
| `12.P09` | A single A* solve, worst case | ≤ 1.0 ms | `tests/nav/astar.test.js` |
| `12.P10` | Audio graph node count, worst case | ≤ 320 live nodes | `audio-bench.mjs` |
| `12.P11` | GC pauses over a `playtest` run | none longer than 8 ms | `playtest.mjs` |

**Measurement discipline.** Frame-time gates are p-values over 600 captured
frames after a 120-frame warm-up, on a fixed shot, at a fixed DPR, with the
compositor unthrottled. A single frame is not a measurement. `12.P05` is
absolute rather than a p-value because one shader compilation is a 600–900 ms
hitch, and the `prewarm` pass exists solely to make it impossible.

**Where they block.** `12.P01`–`12.P07` are advisory until **M8** and blocking
from **M9**, because a visual pass that has not happened cannot be held to a
frame budget. `12.P05`, `12.P08` and `12.P09` are blocking from the milestone
that introduces them (M0, M1, M1), because each guards an architectural
property rather than a polish target.

---

## 9. The pixel gate

`tools/baseline.mjs` renders a fixed set of named shots, each in an isolated
page with a fresh context; `tools/imagediff.mjs` compares them against
`tests/fixtures/shots/` and exits non-zero on **any** differing pixel.

### 9.1 The shot set

| Shot | What it pins | From |
|---|---|---|
| `boot_clean` | the first frame, empty scene, camera at rest | M0 |
| `town_overview` | Last Bastion from the standard camera | M6 |
| `wastes_seed_a` / `wastes_seed_b` | two fixed Wastes layouts | M5 |
| `bonereach_hall` | interior lighting and the tile kit | M5 |
| `altar_arena` | the boss arena, empty | M6 |
| `dense_combat` | 22 monsters, 4 skill effects, 9 ground items — the readability shot | M5 |
| `inventory_full` | the grid, a rare tooltip with comparison, the paperdoll | M3 |
| `skill_tree_ravager` | the tree at 29 allocated points | M4 |
| `vendor_open` | vendor + inventory, both scrolled | M3 |
| `boss_phase_2` | Molgrim mid-fire-ring, telegraph visible | M6 |
| `ui_clean` | the overlay with no world behind it | M2 |
| `equip_four_slots` | the four visual equipment slots, all changed | M7 |

Twelve shots, each with a reason to exist. `dense_combat` is the one that earns
its place twice: it is the readability gate *and* the performance gate, and both
`readability.mjs` and `profile.mjs` use it.

### 9.2 Zero tolerance, and why it is affordable

The gate is exact — not a perceptual metric, not a threshold. That is only
possible because the frame is deterministic by construction: the RNG is seeded,
the simulation is stepped in lockstep by `src/dev/shots.js`, no CSS transition
runs (`09-ui.md`'s rule that everything integrates from `dt` in `lateUpdate`),
and the camera is at a scripted transform.

If a shot ever becomes unstable at the pixel level, the response is to find and
remove the non-determinism, not to loosen the gate. A perceptual threshold hides
exactly the one-pixel-per-frame drift that indicates a real bug.

### 9.3 Blessing a change

A deliberate visual change makes the gate red. That is the point.

```
node tools/baseline.mjs --bless --shot dense_combat
```

writes the new PNG, and the review sees the before/after in the diff. A bless
that touches more than three shots in one commit is a signal that the change was
larger than intended, and is called out in review as such.

---

## 10. CI

Four stages. Each starts only if the previous passed, because a red import lint
makes every downstream result meaningless.

| # | Stage | Surface | Contents | Budget | Blocks |
|---:|---|---|---|---:|---|
| 1 | **lint** | N | `check-imports`, `check-fixed`, `npm run build` | 45 s | everything |
| 2 | **unit** | N | `node --test tests/`, including the `A` allocation probes | 60 s | stages 3–4 |
| 3 | **harness** | N | `lootsim`, `balance`, `mapgen`, `save-fuzz`, `audio-bench`, in parallel | 90 s | stage 4 |
| 4 | **visual** | B, P | `baseline` → `imagediff`, then `profile`, then `playtest` | 6 min | merge |

Total wall clock on a green run: **under 9 minutes.**

### 10.1 What runs when

| Trigger | Stages |
|---|---|
| every push to a branch | 1, 2, 3 |
| every pull request | 1, 2, 3, 4 |
| merge to `main` | 1, 2, 3, 4, plus `playtest --campaign` (10 consecutive runs) |
| nightly | everything, plus `lootsim --drops 2000000` and `mapgen --seeds 2000` |

The nightly sweep exists because a one-in-two-thousand generator failure is
invisible at 200 seeds and fatal in a shipped build. It opens an issue with the
failing seed rather than failing a build nobody is watching.

### 10.2 The minimum bar, restated

`ARCHITECTURE.md` rule 8 says `npm run build` must pass and
`node tools/capture.mjs` must produce a frame after any change. That is stage 1
plus one command, it takes under a minute, and it is what an agent runs locally
before handing work back. Everything else in this document is CI's job.

---

## 11. Milestone gates

Each milestone's acceptance criterion in `IMPLEMENTATION_PLAN.md` §9 becomes a
concrete, runnable gate here. A milestone is done when its row is green and
stays green.

| Milestone | Gate |
|---|---|
| **M0** Skeleton | `npm run build`; `capture.mjs --shot boot_clean` produces a non-blank frame; `check-imports` passes; `12.D07` passes on an empty world |
| **M1** World and nav | `12.P08` (`nav.rebuild ≤ 3 ms`), `12.P09` (A* ≤ 1 ms); `tests/nav/` green; a capsule crosses the test map without wedging in 200 scripted runs |
| **M2** Actors and combat | **All fourteen of `03.E01`–`03.E14` reproduce exactly**; `12.A01` and `12.A02` pass; `ui_clean` enters the baseline |
| **M3** Loot and inventory | `lootsim.mjs` green on all 36 configurations; `04.G01`/`04.G02` inside tolerance; `inventory_full` and `vendor_open` enter the baseline |
| **M4** Classes and skills | `balance.mjs --skills` green over all 30; each class clears the test room; `05.B08` (no negative resource, ≥ 8 s burst window) passes; `skill_tree_ravager` enters the baseline |
| **M5** Zones and bestiary | `mapgen.mjs` green on 5 400 layouts; `balance.mjs --monsters` green; `wastes_*`, `bonereach_hall` and `dense_combat` enter the baseline |
| **M6** Town, quest, boss | `playtest.mjs` completes the full campaign on three seeds; `save-fuzz.mjs` green; `13.P01`–`13.P04` pass; `town_overview`, `altar_arena` and `boss_phase_2` enter the baseline |
| **M7** Full trees and uniques | `balance.mjs --sweep` green over 4 158 builds — **`05.B07` (spread < 2×) is the gate this milestone exists to satisfy**; `equip_four_slots` enters the baseline |
| **M8** Visual pass | Every shot re-blessed **once**, deliberately, in one commit; `readability.mjs` and `silhouette.mjs` green; `mannequin.mjs` ≥ 12 % |
| **M9** Audio, perf, polish | `12.P01`–`12.P11` all blocking and green; `audio-bench` and `audio-probe` green; `playtest.mjs` passes 10 consecutive runs; `imagediff` green |

The M8 row is deliberately unusual. A visual pass changes every shot, so the
baseline is re-blessed exactly once, in a single reviewed commit, at the end of
the pass — not shot by shot as the work proceeds. Blessing incrementally during
M8 would let an unintended change ride along with an intended one, which is the
failure mode the gate exists to prevent.

---

## 12. Failure output

One line per failure on `stderr`, machine-parseable, sorted by the namespaced
id, then by scope:

```
FAIL  <doc>.<id>  <scope>  <detail>  expected=<expected>  actual=<actual>  delta=<delta>
```

Notes use the same shape with `NOTE` and never affect the exit code:

```
FAIL  05.B07  build=R-B/whirlwind-20        expected=<2.00x  actual=2.34x  delta=+0.34
FAIL  07.I02  zone=bonereach seed=0x3C91A0  expected=reachable  actual=region 4  delta=—
NOTE  05.B09  build=B-B/discharge-20        no blade_seal — Resonance has no sink by construction
```

Followed by a summary block on `stdout`:

```
balance.mjs  seed=0x5eed0001  skills=30  builds=4158  elapsed=8.42s
  per-skill   360 checks   360 pass   0 fail
  per-build  45738 checks 45736 pass   2 fail   112 notes
  RESULT: FAIL (2)
```

Three rules make this output usable rather than decorative:

1. **Every failure prints its seed and a repro command.** A failure a developer
   cannot reproduce in one command is a failure that gets muted.
2. **Every failure prints all of them, never just the first.** Fixing one number
   in a balance table often moves five, and finding that out one CI run at a
   time costs a day.
3. **The delta is signed and in the assertion's own units.** `+0.34x` says
   how far, which is the difference between a typo and a design problem.

---

## 13. What we deliberately do not test

Recorded so the question is not reopened every milestone.

| Not tested | Why |
|---|---|
| **Line coverage percentage** | §4.3. It rewards execution without assertion, which is the opposite of what a numbers-heavy suite needs. |
| **Private methods** | If it is not in `02-api-contracts.md` it has no contract, and a test against it freezes an implementation detail. |
| **`fx`, `sky` and `render` internals** | Their output is pixels, and the pixel gate is the test. A unit test over a shader parameter pins a number nobody chose deliberately. |
| **Audio timbre** | `audio-bench` asserts node counts, lengths and peak levels — the things that can regress silently. Whether a sword sounds good is a listening decision, and `--sheet` exists to support it, not to gate it. |
| **Cross-browser behaviour** | Desktop Chromium only, by the plan's platform decision. Firefox and Safari are not tested because they are not supported. |
| **Touch, gamepad, mobile layout** | Not supported. Same reason. |
| **Localisation completeness beyond key presence** | `13-progression-lore.md` §14.1's boot check asserts every key resolves in both dictionaries. Whether a Russian line reads well is a human review. |
| **Load testing / concurrency** | Single player, no backend, no network code. There is nothing to load. |
| **Mutation testing** | Attractive on paper for a suite this arithmetic-heavy, but it multiplies a 90-second N-surface run by ~200. Revisit after M9 if the suite ever proves permissive. |

---

## 14. Implementation order

Eight steps. Each is independently useful and leaves the build green.

| # | Step | Deliverable | Verified by |
|---|---|---|---|
| **1** | Runner and helpers | `tests/helpers/`, the state hash, the seeded actor builders, `node --test` wired into `npm test` | `npm test` runs and passes with one trivial test |
| **2** | `check-imports` and `check-fixed` | Both lints, wired as CI stage 1 | Deliberately importing `three` into `src/combat/` fails the lint |
| **3** | `capture.mjs` + `imagediff.mjs` | The two ported tools, one shot (`boot_clean`) | `ARCHITECTURE.md` rule 8's minimum bar is enforceable |
| **4** | The `E` tests | All fourteen worked examples from `03-combat-math.md` §12 | M2's gate |
| **5** | `lootsim.mjs` | The full distribution harness | M3's gate; `12.D03` passes |
| **6** | `balance.mjs` | Skills, builds, sweep, monsters, progression | M4's and M7's gates; `12.D01` passes |
| **7** | `mapgen.mjs` + `save-fuzz.mjs` | The generator and persistence harnesses | M5's and M6's gates; `12.D02` passes |
| **8** | `baseline.mjs`, `profile.mjs`, `playtest.mjs`, the allocation probes | The full B surface and CI stage 4 | M9's gate |

Steps 1–3 are the critical path and belong in **M0**, before any gameplay code
exists. A harness written after the subsystem it tests is a harness written to
agree with the code rather than with the specification, and it will agree with a
bug just as readily.

---

## 15. Deviations and decisions owned by this document

**D-12-1 — Assertion ids are namespaced by document number.**
Five documents chose `S`, four chose `B`. `05.B07` and `11.B07` are different
assertions and today's ids cannot distinguish them. Namespacing is the smallest
fix; renaming five documents' assertion sets is not. §3 carries the reserved
letters so the next set does not collide either.

**D-12-2 — `node --test`, not a framework.**
`ARCHITECTURE.md` rule 3 forbids new dependencies, and the runtime already ships
a runner with a TAP reporter, filtering, concurrency and subtests. The cost is
no snapshot testing and a plainer watch mode. Both are acceptable; the fixtures
of §6 are a better fit for this project than snapshots anyway, because they are
reviewed as content.

**D-12-3 — Zero retries, and code `3` is not code `1`.**
Every input in this project is seeded, so a test that fails intermittently is
reporting a real defect in the most valuable way it can. Retrying it converts
the project's single most important invariant into noise. A determinism break
gets its own exit code because it invalidates every other result in the run.

**D-12-4 — Performance gates are advisory until M8.**
Holding an unlit, untextured M4 build to a 16.7 ms frame budget produces a green
gate that means nothing, and holding it there after M8 produces a red gate
nobody can act on. The three that guard architecture rather than polish —
shader compilations, `nav.rebuild`, A* — are blocking from the milestone that
introduces them.

**D-12-5 — The pixel gate is exact, not perceptual.**
Determinism is what makes zero tolerance affordable, and zero tolerance is what
makes determinism observable. The two hold each other up. If a shot becomes
unstable, the non-determinism is the bug.

**D-12-6 — Fixture weight is budgeted, and shots are the first thing cut.**
12 MB total, ~9 MB of it PNGs. A baseline nobody reviews is a baseline that gets
blessed reflexively, and a large set makes that outcome more likely, not less.

**D-12-7 — `playtest.mjs` scripts input, it does not play.**
An AI player is a second thing to debug and a source of exactly the
non-determinism §7 exists to eliminate. The script is a fixed sequence of
intents at a fixed seed; when the game changes such that the script no longer
completes, that is a signal worth having rather than noise to suppress.
