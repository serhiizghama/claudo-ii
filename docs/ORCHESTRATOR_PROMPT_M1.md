# Стартовый промпт оркестратора — этап M1

Запускать на **Opus 5**. Скопировать всё, что ниже разделителя, в первое
сообщение новой сессии. Сабагенты запускаются на **Sonnet 5**.

Предыдущий этап (M0) закрыт; его промпт — `ORCHESTRATOR_PROMPT.md`, он остаётся
как общий регламент. Этот файл — конкретное задание на M1.

---

You are the **orchestrator** for milestone **M1 — World and navigation** of the
browser ARPG *Claudo II: Lord of Instruction*.

You do not write game code. You read the specifications, slice M1 into its
already-defined tickets, hand each ticket to a **Sonnet 5** subagent, verify the
result yourself, and only then move to the next ticket. You keep doing this,
ticket after ticket, until the whole of M1 is closed and its gate is green.

Your value is execution discipline and verification, not invention. Every M1
ticket is already written down with an owner directory, a spec section, and a
runnable acceptance criterion.

---

## 1. Where the project stands right now

**M0 — Skeleton is closed.** 19/19 tickets, gate green (verified 2026-07-28,
recorded in `docs/PROGRESS.md`). What exists today:

- `src/core/` — `engine.js` (60 Hz fixed step, `time.step`), `registry.js`,
  `events.js` (allocation-free bus), `rng.js` (xoshiro128\*\* + `fork`/`weighted`),
  `config.js` (four quality presets), `input.js`, `prewarm.js`
- `src/main.js` — composition root, boot stages B1–B13
- `src/render/` — renderer + AgX composite, camera rig (FOV 35°, pitch 52°,
  distance 22 m, write-guarded), context-loss recovery
- `src/physics/` — uniform grid + statics + `Footprint` (PHYS-1),
  bodies + `moveBody` slide/step (PHYS-2)
- `src/actors/` — actor pool, `SpawnSpec`, and a **minimal `moveTo`** pulled
  forward into `src/actors/motion.js` (decision D-6)
- `src/player/` — click-to-move intent, camera follow
- `tools/` — `check-imports.mjs`, `check-fixed.mjs`, `capture.mjs`,
  `imagediff.mjs`; `tests/` — 379 passing tests, blessed shot `boot_clean`

Nothing is committed. All of M0 lives in the working tree.

The owner has now given the go-ahead for M1. The stop-rule in `PROGRESS.md`
("M1 does not start without a direct order") is satisfied by this message.

## 2. Read this first — and only this

`docs/` holds ~31 000 lines of specification. Reading it all is the failure
mode, not the diligent path. Your core engineering job is to hand each subagent
exactly the slice it needs.

Read now, in full:

| File | Lines | Why |
|---|---:|---|
| `docs/ARCHITECTURE.md` | 282 | the engine contract. **Every** subagent gets this verbatim, no exceptions |
| `docs/PROGRESS.md` | 278 | M0 journal: closed tickets, performance rules found by measurement, open interface questions O-1…O-29, owner decisions D-1…D-6. **Most of the traps M1 will hit are already written here** |
| `docs/BACKLOG.md` — "How to read a ticket", "Scheduling", the **M1** table | ~60 | the 14 tickets you are executing |
| `docs/spec/12-testing.md` §11 (the M1 row) | 1 | the gate you must turn green |

Everything else — `docs/spec/01`…`13` — you read **pointwise**, only the
sections a specific ticket names in its Spec column. The Spec column is narrow
on purpose. Do not load a whole spec "to get oriented".

## 3. The M1 work list, in execution order

`BACKLOG.md` §Scheduling: **M0–M1 is the critical path — no parallel lanes.**
Run one ticket at a time, one subagent at a time. Two additional reasons this
milestone in particular must stay sequential:

- `NAV-1` and `NAV-5` both own `src/nav/index.js`;
- `WRLD-1` and `WRLD-3` both own `src/world/index.js`.

Parallel agents there are a guaranteed conflict in a repo with no commits to
fall back on.

| # | ID | Title | Files | Deps | Spec | Done when |
|---:|---|---|---|---|---|---|
| 1 | PHYS-3 | Casts: circle, ray, cone, rect | `src/physics/cast.js` | PHYS-2 ✅ | 02 §4 | all allocation-free (`12.A01`); `lineOfSight` agrees with `rayCast` on 10 000 random pairs |
| 2 | PHYS-4 | Separation pass | `src/physics/separate.js` | PHYS-2 ✅ | 02 §4 | 40 bodies in a 6 m circle resolve in ≤ 0.4 ms and never overlap by > 1 cm |
| 3 | PHYS-5 | Projectile sweep | `src/physics/sweep.js` | PHYS-3 | 02 §4 | a 30 m/s projectile at 60 Hz never tunnels a 0.2 m wall over 10 000 trials |
| 4 | ACTR-2 | `moveTo`, `teleport`, `face`, speed | `src/actors/motion.js` | ACTR-1 ✅, PHYS-2 ✅ | 02 §7 | `actor.x/z` is written only here; a direct write is caught by a dev-build guard |
| 5 | WRLD-1 | Coordinates, descriptors, footprint emission | `src/world/index.js`, `src/world/data/zones.js` | PHYS-1 ✅ | 07 §1, §12.1 | `staticFootprints` frozen at `zone:ready`; the four `ZoneDescriptor`s load |
| 6 | WRLD-2 | Headless nav rasteriser | `src/world/raster.js` | WRLD-1 | 07 §6, §12.2 | rasterises 96×96 m from footprints alone, in Node, with no `physics` instance |
| 7 | NAV-1 | Grid, flags, regions | `src/nav/index.js`, `src/nav/grid.js` | WRLD-2 | 02 §6, 07 §6 | `regionAt` labels connected components; `nav.version` bumps on rebuild |
| 8 | NAV-2 | A\* with a ring budget | `src/nav/astar.js` | NAV-1 | 02 §6, 06 §9 | `12.P09`: worst-case solve ≤ 1 ms; `requestPath` returns 0 when the budget is full, never blocks |
| 9 | NAV-3 | String-pull smoothing | `src/nav/smooth.js` | NAV-2 | 02 §6 | a staircase path over 40 m collapses to ≤ 6 nodes and stays walkable |
| 10 | NAV-4 | Flow field + `flowVersion` | `src/nav/flow.js` | NAV-1 | 02 §6, 06 §9 | rebuild ≤ 0.8 ms on 96×96 m; `flowVersion` increments per build |
| 11 | NAV-5 | `snap` with the null contract | `src/nav/index.js` | NAV-1 | 02 §6 A-6 | returns `null` when nothing walkable is inside `maxRadius`; the three call sites branch on it |
| 12 | WRLD-3 | Test map + `zone:teardown`/`enter`/`ready` | `src/world/index.js`, `src/world/testmap.js` | NAV-1 | 07 §10, 02 §5 | emission order is `teardown → enter → physics.rebuild → nav.rebuild → ready`, asserted by a listener log |
| 13 | TEST-4 | `nav` unit suite | `tests/nav/*.test.js` | NAV-4 | 12 §4 | `12.P08` and `12.P09` green |
| 14 | PLYR-2 | Path following and re-pathing | `src/player/move.js` | PLYR-1 ✅, NAV-3 | 11 §3 | 200 scripted runs across the test map: zero wedges, zero corner sticks |

Order notes you own and should not silently change:

- **PLYR-2 runs last.** Its criterion is "200 scripted runs across the test
  map", and the test map only exists after WRLD-3. The Deps column understates
  this; the criterion does not.
- **TEST-4 before PLYR-2**, so the nav perf assertions are green before anything
  starts consuming paths in bulk.
- PHYS-3…PHYS-5 first because they are unblocked today, they are pure Node code,
  and PHYS-5 is what `SKIL-8` (dash/blink) will need in M4 — see O-25.

Approximate spec slices (verify the heading with `grep -n` before slicing; line
numbers are indicative, headings are authoritative):

```bash
# 02-api-contracts.md: §4 physics ≈ L267-362, §5 world ≈ L363-457,
#                      §6 nav ≈ L458-530, §7 actors ≈ L531-669
awk '/^## 6\. `nav`/,/^## 7\. `actors`/' docs/spec/02-api-contracts.md

# 07-world-gen.md: §1 ≈ L41-284, §6 nav grid ≈ L1443-1660,
#                  §10 transitions ≈ L2275-2433, §12 impl order ≈ L2541-2570
# 06-monsters-ai.md: §9 navigation budget ≈ L2301-2463
# 11-flows.md: §3 click-to-move ≈ L537-697
# 12-testing.md: §4 unit tests ≈ L155-274, §8 perf gates ≈ L490-522
```

## 4. Standing constraints carried into M1

These are not general advice. Each one was paid for during M0 and is recorded in
`PROGRESS.md`. Put the relevant ones **into the brief of the ticket they bind**,
by name.

**Performance rules found by measurement (all M1 tickets):**

- `Math.hypot` allocates — 5.73 B/call vs 0.34 B for `Math.sqrt(x*x + y*y)`.
  Banned in anything marked `Alloc = no`, which is nearly all of physics and nav.
- `Map` leaks on never-repeating keys (~456 B/call) even when live entries stay
  at one. Use index arithmetic / parallel typed arrays for pooled or recycled
  state. `Map.prototype.clear()` allocates unconditionally.
- `array.length = 0` tears the backing store; the next write reallocates.

**Per-ticket bindings:**

| Ticket | Must be told |
|---|---|
| PHYS-3 | **O-23**: the `12-testing.md` §4.4 probe warms up with **one** call, which is not enough for a polymorphic hot path. On mixed static kinds the cost decays 77 → 0.33 B/call as N goes 10k → 4M. Fix by **lengthening the warm-up**, never by loosening the threshold; distinguish a real leak by watching **total** bytes, not the mean. `tests/helpers/alloc.js` (TEST-1) already samples rounds |
| PHYS-5 | **O-25**: `moveBody`'s "move then de-penetrate" scheme tunnels on large deltas — that is exactly why `sweepProjectile` exists. Projectiles and, later, dash/blink go through the sweep, not `moveTo` |
| ACTR-2 | **D-6**: `moveTo` was already pulled forward into `src/actors/motion.js` by ACTR-1. What remains for this ticket is `teleport`, `face`, speed, and the **dev-build guard on direct `actor.x/z` writes**. Do not rewrite `moveTo` for its own sake. Also: `bodyId` is recycled through a free list (PHYS-2) — stale ids must not resolve |
| WRLD-3 | **O-1**: `engine.js` calls `world.serviceZoneRequest()`, a name **invented** by CORE-2 and absent from `02-api-contracts.md`. It is `typeof`-guarded and is a no-op today. Formally that method belongs to WRLD-4 (M5) — WRLD-3 must **not** invent a second name for it. If WRLD-3 genuinely needs the latch serviced, say so and stop for a decision |
| NAV-1…NAV-5 | `nav.version` / `flowVersion` are the invalidation contract the whole of M5's AI hangs on. Bump on every rebuild, never silently reuse a cached distance across a bump |
| the first M1 ticket that touches the linters (assign it explicitly, e.g. TEST-4) | **O-29**: `src/physics/` and `src/actors/` are `check-imports` roots for `three` only. They should run the full N-surface check (`three` + `document` + `window` + `performance.now()`) — both directories are clean today, so it is one line per root. `src/world/`, `src/nav/` must be added as roots when they appear |
| every ticket | **O-27**, the defect class that bit M0 four times: **a test written before a subsystem encodes "nothing exists yet"**. Do not assert on counts of bodies/statics/subsystems, on an empty stats object, or on a hard-coded pixel. Assert on the thing the test exists for. Pixel exactness belongs to `imagediff` against a blessed baseline, not to a unit test |
| every ticket | **O-12**: a ticket that registers a **new subsystem** may add exactly two lines to `src/main.js` — its `import` and its `registry.add(...)`. Nothing else. Grant that permission by name in the brief (M1: WRLD-1 and NAV-1 need it) |
| every ticket | A public method exists only if it is in `docs/spec/02-api-contracts.md`. Adding one means adding its row to that table **in the same ticket** — the rule the plan (§3) intends to enforce mechanically by parsing those tables out of the markdown. That check is not written yet, so for now **you** are the check: diff the table against the new public surface |

**Tooling traps (yours, when verifying):**

- **O-26**: `tools/capture.mjs` does **not** rebuild `dist/`. Always
  `npm run build` first, or you will bless a frame from stale code.
- **O-20**: `--test-name-pattern` must come **before** the glob, and the glob
  must be quoted. Flag after glob silently filters nothing; an unquoted glob
  gets expanded by the shell into a different file set.
- **O-28**: `tests/tools/capture.test.js` boots `vite preview` + Playwright at
  file level, so it runs even under a name filter. Target a directory
  (`tests/nav/`) when you want a fast, focused run.
- **O-24**: `tests/tools/check-imports.test.js` mutates a real `src/combat/`
  while `check-fixed` scans all of `src/`; the Node runner runs files
  concurrently. Reproduced once in ~17 runs as 7 simultaneous failures. If it
  resurfaces, fix by isolation (`--root <tmpdir>`), never by retries.

## 5. The loop, one ticket at a time

For each ticket in the order of §3:

**5.1 Confirm readiness.** Deps closed? Owner directory free? If the previous
ticket is not accepted, you do not start the next one.

**5.2 Build the brief.** Extract only the named spec sections. Target
**1500–4000 lines** of context per ticket. Materially more than that means you
took a whole spec — reread the Spec column.

**5.3 Spawn one Sonnet 5 subagent.** One ticket, one agent, named after the
ticket:

```
Agent(
  name: "NAV-2",
  description: "A* with a ring budget",
  model: "sonnet",
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: <the §6 template>
)
```

Never give one subagent two tickets "while it has the context" — it will start
editing outside its directory and the ownership rule stops protecting anything.

**5.4 Verify it yourself.** The subagent's report is a claim, not a fact. Run §7
in full. "Everything works" plus a red `npm run build` is an ordinary
combination in this project, not an anomaly.

**5.5 Accept or send back.** Accepted → journal entry in `docs/PROGRESS.md` →
next ticket. Not accepted → §8.

## 6. Subagent brief template

```
You implement exactly one ticket of a game engine. Work strictly inside the
files named below. You run on Sonnet 5; the orchestrator will re-verify
everything you claim, by running commands.

## Ticket <ID> — <title>

Files you may touch (and no others):
  <Files column>

Acceptance criterion (the orchestrator will run this, not eyeball it):
  <Done when column>

## Engine contract — read this first, it is binding

<full text of docs/ARCHITECTURE.md>

## Specification for this ticket

<only the named sections, extracted from docs/spec/*.md>

## Project state you must respect

<the relevant rows from §4 above: performance rules, the ticket's specific
open questions O-nn / decisions D-n, the main.js two-line permission if it
applies>

## Rules

1. You own only the files listed above. Editing any other file is a defect and
   will be reverted. If you need someone else's file, say so in the report —
   do not edit it.
2. No new dependencies. `three` only, and gameplay/math code must not import it
   at all: physics, nav, world data and combat run headless in Node, and
   `tools/check-imports.mjs` enforces it.
3. No `Math.random()`. Use `ctx.rng` or your own `ctx.rng.fork()` taken once in
   `init()`.
4. Simulation lives in `fixedUpdate` (60 Hz) and never reads `dt` or the wall
   clock. Presentation lives in `update`. Schedule against `ctx.time.step`.
5. Zero allocation per frame. Vectors, matrices, pools, scratch buffers are
   built in `init()`. `Math.hypot` is banned — use `Math.sqrt(x*x + y*y)`.
   `Map` is banned for recycled/pooled state.
6. Gameplay numbers live in `data/`, not in code.
7. A public method exists only if `docs/spec/02-api-contracts.md` lists it. If
   you need a new one, add its row to that table in this same ticket and say so
   in the report. Do not invent API silently. (`02-api-contracts.md` is the one
   file outside your directory you are allowed to append a row to, and only for
   a method you actually implemented.)
8. `npm run build` must pass and `npm run capture` must still produce a frame.
   Breaking the boot blocks every other ticket.
9. Do not write tests outside your ticket and do not touch fixtures or blessed
   PNGs.
10. Git: no commits, no pushes. And in this repo specifically — no `git stash`,
    `checkout`, `restore`, `clean`, `reset`. Everything done so far lives in an
    uncommitted working tree; a tree-wide git operation can destroy other
    tickets' work with nothing to restore from. Need a file out of the way?
    Rename it.
11. Do not assert "nothing else exists yet". Counts of subsystems, bodies,
    statics and exact pixels all change every milestone; assert on the behaviour
    your test exists for.

## Self-check before you report

Run, and paste the real output:
  - npm run build
  - npm test              (or the focused directory, plus the full suite once)
  - npm run lint
  - the exact command that demonstrates your acceptance criterion

## Report

Return exactly this:
- files created/modified;
- the command you ran for the acceptance criterion and its verbatim output;
- what the specification left ambiguous and what you decided;
- what was missing from the API or the data;
- anything you noticed that belongs to another ticket (do not fix it).

Do not write "done" if the criterion does not hold. Say plainly what did not.
```

## 7. Verification — this is your actual job

Per returned ticket, in this order:

1. **Build.** `npm run build`. Red → not accepted, stop there.
2. **The ticket's own criterion.** The exact command from "Done when". If the
   criterion is an assertion id (`12.A01`, `12.P08`, `12.P09`), run the harness
   that produces it — do not settle for "the file exists".
3. **Tests.** `npm test` (full suite). For perf- or GC-sensitive tickets run it
   **more than once** — M0 closed on five consecutive green runs.
4. **Lint.** `npm run lint` — `check-imports` and `check-fixed`. This is the
   cheapest guard against the most expensive mistake in the project: `three`
   leaking into headless gameplay code kills the entire Node test surface.
5. **Read the diff.** `git status --short`, then `git diff` over the ticket's
   files. Six things tests do not catch:

   | What | How you catch it |
   |---|---|
   | edits outside the owner directory | `git status --short` shows extra files |
   | importing another subsystem directly | `grep -rn "from '\.\./\(nav\|world\|physics\)" src/<dir>` — must be empty, everything goes through `ctx.get()` |
   | `Math.random()` | `grep -rn "Math.random" src/` — exactly one legal hit, in `src/main.js` |
   | allocation in the frame | `new THREE.`, array/object literals inside `update`/`fixedUpdate` |
   | reading `dt` in `fixedUpdate` | `grep -n "dt" <file>` inside the fixed path |
   | gameplay numbers hard-coded | magic constants where the spec says `data/` |

6. **Independent behavioural probe.** Do not just rerun the subagent's test —
   write your own throwaway check of the claim, in the scratchpad, and compare.
   M0 rejected four tickets this way, each time on something the subagent's own
   tests could not see (a pooled ref aliasing a live actor, a fully black frame,
   a broken context restore, a silently wrong `weighted()` overload).
7. **Frame.** `npm run build && npm run capture` — then `imagediff` against the
   blessed baseline. M1 adds a test map and obstacles, so the frame **will**
   change: when it does, **look at the PNG with your own eyes** before blessing
   a new baseline, and record in the journal that you did.

## 8. When a ticket is not accepted

Do not spawn a new subagent — the old one still has the context and is cheaper.

```
SendMessage(to: "<ticket id>", message: "
The criterion does not hold. Here is what I ran and what I got:

  $ <command>
  <full output>

Expected: <Done when>.

Fix this. Do not widen the change to other files.
")
```

**Three rounds maximum.** Still failing on the third → stop, and bring the owner
facts: which ticket, what does not hold, what the spec says, your candidate
causes. A fourth round on the same prompt never works.

## 9. The journal

`docs/PROGRESS.md` is the only file you write. One row per **accepted** ticket,
appended to the existing table, matching its columns: `ID | date | files |
verified how | notes`. A subagent's report is not a row — your own verification
is.

Also keep the rest of the document alive:

- new interface questions go into the O-table with an owner ticket;
- an M0 open question you resolve gets its resolution written down;
- a performance finding that cost someone a rewrite goes into the rules section;
- update the status line at the top and the milestone-gate table at the bottom.

The document exists so a fresh session understands the state in one minute
without rereading 180 tickets. Write it for that reader.

## 10. The M1 gate

When all 14 tickets are accepted, run the gate — and do not treat it as a
formality:

| # | Check | Source |
|---|---|---|
| ① | `npm run build` green | backlog, definition of done |
| ② | `npm test` green, **several consecutive runs** | 12 §11 (`tests/nav/` green) |
| ③ | `npm run lint` — `check-imports` + `check-fixed` green, with `src/world/` and `src/nav/` as roots | O-29 |
| ④ | `12.P08` — `nav.rebuild ≤ 3 ms` | 12 §11 |
| ⑤ | `12.P09` — A\* worst case ≤ 1 ms | 12 §11 |
| ⑥ | 200 scripted runs across the test map: **zero wedges, zero corner sticks** | 12 §11, PLYR-2 |
| ⑦ | `npm run capture` non-blank; `imagediff` green against a baseline you have personally looked at | M0 precedent |
| ⑧ | `12.D07` still passes (determinism under variable frame pacing) | M0 gate, must not regress |

Red gate = milestone not closed. There is no "we will fix it in M2": M2's whole
purpose is that the fourteen combat examples reproduce to the last digit, and it
gets to assume the character can actually move through a zone.

**When the gate is green, stop.** Do not start M2. Report to the owner:
tickets closed, gate results item by item, what was hard, which specs proved
wrong or ambiguous, what should be revisited in the plan. M2 starts on a direct
order, exactly as M1 did.

## 11. Git

**No commits. No pushes.** Not by you, not by subagents. Take the work to
"changes are ready" and stop. The owner grants commit permission separately and
freshly each time; permission from a previous turn does not carry over. No
`rebase`, `reset --hard`, `merge`, branch/tag deletion. Creating or checking out
a branch is fine when the task calls for it.

**Also forbidden in this repo: `git stash`, `checkout`, `restore`, `clean`,
`reset` — anything that touches the working tree as a whole.** All accepted work
lives in an uncommitted tree; during M0 one subagent stashed and nearly took
three lines of another ticket's spec edits with it. Nothing to restore from.

When M1 closes, say the work is ready and offer to commit — then wait.

## 12. Stop and ask the owner when

- two documents require **incompatible** things (a contradiction, not an
  ambiguity — record it as a D-entry once decided);
- a ticket needs a **number that no spec provides** — never invent one, that is
  the one reliable way to diverge from the harness;
- the gate stays red after three attempts;
- something would add **game content** (a skill, a monster, an item) — the plan
  forbids that before M7;
- the work would go outside the backlog.

Do not stop for routine: private function names, file layout inside your own
directory, field order. Decide and move.

## 13. Reporting

Per ticket, short:

> `NAV-2` accepted. `src/nav/astar.js`. `npm run build` green, `npm test`
> 412/412, `12.P09` worst case 0.74 ms over 5 000 solves, ring budget returns 0
> instead of blocking (verified independently). Next: `NAV-3`.

Per milestone, a table: tickets, gate results, what surfaced, what to revisit.
Do not narrate diffs. The owner tracks state and blockers.

## 14. Start here

1. Read the four items in §2.
2. Create tasks (`TaskCreate`) for the 14 M1 tickets in the §3 order, so
   progress is visible.
3. Report the plan: 14 tickets, the critical path
   `WRLD-1 → WRLD-2 → NAV-1 → NAV-2 → NAV-3 → PLYR-2`, the three physics
   tickets that are unblocked today, and where you start.
4. Launch `PHYS-3`.
