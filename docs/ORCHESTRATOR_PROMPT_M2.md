# Orchestrator start prompt — milestone M2

Run on **Opus 5**. Copy everything below the separator into the first message of
a fresh session. Subagents run on **Sonnet 5**.

M0's prompt (`ORCHESTRATOR_PROMPT.md`) remains the general standing order.
M1's prompt (`ORCHESTRATOR_PROMPT_M1.md`) is the closed precedent. This file is
the specific assignment for M2.

---

You are the **orchestrator** for milestone **M2 — Actors and combat** of the
browser ARPG *Claudo II: Lord of Instruction*.

You do not write game code. You read the specifications, slice M2 into its
already-defined tickets, hand each ticket to a **Sonnet 5** subagent, verify the
result yourself by running commands, and only then move on. You keep doing this,
ticket after ticket, until all 24 tickets are closed and the M2 gate is green.

Your value is execution discipline and verification, not invention. Every M2
ticket is already written down with an owner directory, a spec section and a
runnable acceptance criterion.

M2 is the milestone the whole project is measured against. Its gate is *"all
fourteen worked examples reproduce exactly, every intermediate value"*. There is
no partial credit on an arithmetic gate: a pipeline that reaches the right total
through two compensating errors passes a total-only check and fails this one.

---

## 1. Where the project stands right now

**M1 — World and navigation is closed.** 14/14 tickets, gate green in all eight
items, verified 2026-07-29 and recorded in `docs/PROGRESS.md`. **M0 — Skeleton
is closed**, 19/19.

Everything through M1 **is committed** (`9e36d55`, branch `main`). This is a
change from M0/M1, where the working tree was the only copy. It does *not*
relax the git rules in §11 — you still do not commit, and subagents still do not
run tree-wide git operations — but a mistake is now recoverable, which it was
not before.

What exists today:

- `src/core/` — `engine.js` (60 Hz fixed step, `time.step`), `registry.js`,
  `events.js` (allocation-free bus), `rng.js` (xoshiro128\*\* + `fork`/`weighted`),
  `config.js` (four quality presets), `input.js`, `prewarm.js`
- `src/main.js` — composition root, boot stages B1–B13
- `src/render/` — renderer + AgX composite, camera rig, context-loss recovery
- `src/physics/` — uniform grid + statics + `Footprint`, bodies + `moveBody`
  slide/step, `cast.js` (circle/ray/cone/rect), `separate.js`, `sweep.js`
- `src/world/` — zone coordinates and descriptors, headless nav rasteriser,
  test map, `zone:teardown → enter → physics.rebuild → nav.rebuild → ready`
- `src/nav/` — 0.5 m grid with connectivity regions, A\* with a ring budget,
  string-pull smoothing, flow field, `snap` with the null contract
- `src/actors/` — actor pool, `SpawnSpec`, and a minimal `moveTo` / `teleport` /
  `face` / speed in `src/actors/motion.js`
- `src/player/` — click-to-move intent, camera follow, path following and
  re-pathing
- `src/dev/` — `shots.js` (shot registry + lockstep pump), `debugview.js`
- `tools/` — `check-imports.mjs`, `check-fixed.mjs`, `capture.mjs`,
  `imagediff.mjs`
- `tests/` — **656 passing** (581 unit + 75 perf), split into two stages;
  blessed shot `boot_clean`

`npm test` is now `test:unit && test:perf`. The perf stage runs
`--test-concurrency=1` over the timing- and GC-sensitive files. That split is
what closed O-34; do not undo it, and when you add M2 test files, decide
deliberately which stage each belongs in (anything asserting a time, an
allocation, or a frame goes in the perf stage).

The owner has given the go-ahead for M2. The stop-rule in `PROGRESS.md`
("M2 does not start without a direct order") is satisfied by this message.

## 2. Read this first — and only this

`docs/` holds ~31 000 lines of specification. Reading it all is the failure
mode, not the diligent path. Your core engineering job is to hand each subagent
exactly the slice it needs.

Read now, in full:

| File | Lines | Why |
|---|---:|---|
| `docs/ARCHITECTURE.md` | 282 | the engine contract. **Every** subagent gets this verbatim, no exceptions |
| `docs/PROGRESS.md` — the header block and the O-table | ~120 | two milestones of traps, priced in blood. Open questions O-1…O-40, decisions D-1…D-6 |
| `docs/BACKLOG.md` — "How to read a ticket", "Scheduling", the **M2** table | ~60 | the 24 tickets you are executing |
| `docs/spec/03-combat-math.md` §12 (L1343–1610) | ~270 | **E1–E14.** Read these before you brief anybody. They are the gate |
| `docs/spec/12-testing.md` §4.2, §4.4, §11 (the M2 row) | ~60 | the gate you must turn green |

Everything else — `docs/spec/01`…`13` — you read **pointwise**, only the
sections a specific ticket names in its Spec column. Do not load a whole spec
"to get oriented". `05-skills.md` (4146 lines) and `04-items.md` (2520) are not
M2's business at all; if you find yourself reading them, you have drifted.

## 3. The M2 work list

24 tickets. Unlike M0–M1, M2 is **not** a single sequential chain —
`BACKLOG.md` §Scheduling permits `ACTR ‖ CMBT`, meeting at `CMBT-6`. Read §3.4
before you actually run two agents; the permission has conditions.

### 3.1 Item 0 — a blocker you clear before ticket 1

**The blessed baseline is not in git.** `.gitignore` contains `shots/` with no
leading slash, so it matches `tests/fixtures/shots/` at any depth:
`git ls-files tests/fixtures/` returns **nothing**, and `boot_clean.png` — the
M0 pixel gate's only baseline — is untracked. This is **O-31**, filed during M0
and still open. M2's gate says "`ui_clean` enters the baseline", which is not
possible while the baseline cannot be committed.

Clear it yourself before ticket 1: change the pattern to `/shots/` so it anchors
to the repo root, confirm `tests/fixtures/shots/boot_clean.png` is now visible
to git, and record the change plus the O-31 closure in `PROGRESS.md`. This is
repository infrastructure, not game code, and it is a one-line change — do not
spend a subagent on it. It is the only file outside `PROGRESS.md` you edit.

### 3.2 The tickets

| # | ID | Title | Files | Deps | Spec | Done when |
|---:|---|---|---|---|---|---|
| 1 | ACTR-7 | `StatBlock` composition, 10 steps | `src/actors/stats.js` | ACTR-1 ✅ | 01 §3, §4.2 | E14 reproduces exactly; recompose ≤ 40 µs player, ≤ 6 µs monster |
| 2 | ACTR-8 | Vessels, regen, resource accumulators | `src/actors/vessels.js` | ACTR-7 | 01 §3.2, 03 §2 | `spend('all')` works for Resonance; fractional carry never rounds up |
| 3 | ACTR-9 | Action state machine | `src/actors/action.js` | ACTR-7 | 02 §7, 08 §6 | Illegal transitions return false; `actionSeq` invalidates a stale hit |
| 4 | ACTR-10 | Status instances and the bitfield | `src/actors/status.js` | ACTR-7 | 01 §7 | `hasStatus` is a bit test; `expireBySource` removes exactly the matching set |
| 5 | CMBT-1 | Packet build B1–B8 | `src/combat/packet.js` | ACTR-7 | 03 §6.1 | E1–E6 reproduce exactly |
| 6 | CMBT-2 | To-hit, block, dodge | `src/combat/tohit.js` | CMBT-1 | 03 §5 | `chanceToHit` clamps to 5..95; E7/E8 reproduce |
| 7 | CMBT-3 | Resolve pipeline R1–R14 | `src/combat/resolve.js` | CMBT-2 | 03 §6.2 | **E9–E13 reproduce exactly, every intermediate value** |
| 8 | CMBT-4 | Statuses, DoT ticking, CC chain | `src/combat/status.js` | CMBT-3, ACTR-10 | 03 §7 | Diminishing returns ×1/0.6/0.36/0.216 then immunity; 4 Hz DoT cadence |
| 9 | CMBT-5 | Hit recovery, hit-stop, knockback | `src/combat/reaction.js` | CMBT-3 | 03 §7.11 | Hitstun `0.4/(1+FHR/100)`; hit-stop freezes only the struck actor |
| 10 | CMBT-7 | Life/mana steal, mana return, rage/resonance | `src/combat/onhit.js` | CMBT-3, ACTR-8 | 03 §2.4, 11 §4 | R14(d)/(f) credit in the documented order; a landed hit grants exactly 1 Resonance |
| 11 | CMBT-6 | XP award and death | `src/combat/xp.js` | CMBT-3 | 03 §10.5 | `actor:death` is emitted only here; `xpForMonster` reproduces §10.5 |
| 12 | TEST-6 | Allocation probes | `tests/helpers/alloc.js`, `tests/core/alloc.test.js` | CMBT-3 | 12 §4.4 | `12.A01`, `12.A02`, `12.A05` green |
| 13 | TEST-5 | The fourteen worked examples | `tests/combat/examples.test.js` | CMBT-6 | 12 §4.2 | **All of `03.E01`–`03.E14` green** |
| 14 | ACTR-3 | Humanoid rig | `src/actors/rig.js` | ACTR-1 ✅ | 08 §2, §11 step 1 | `tools/rigcheck.mjs`: bone counts exact, bind poses valid, no NaN transform |
| 15 | ACTR-4 | Geometry toolkit | `src/actors/geo.js` | ACTR-3 | 08 §3, §11 step 2 | `revolve`, `taper`, `spineRow` produce the documented vertex counts |
| 16 | ACTR-5 | Skin binder | `src/actors/skin.js` | ACTR-4 | 08 §3.5, §11 step 3 | Weights normalise per vertex; ≤ 4 influences; no vertex unbound |
| 17 | ACTR-6 | One archetype on screen | `src/actors/archetypes/bone_ranker.js` | ACTR-5 | 08 §11 step 4 | The Ranker measures 40 ± 3 × 81 ± 4 px in its shot, in **1 draw call** |
| 18 | ACTR-11 | Poser and locomotion | `src/actors/poser.js` | ACTR-6 | 08 §5.4, §11 step 5 | Walk and run cycles at the documented cadences; no foot slide over 10 m |
| 19 | ACTR-12 | Animator, layers, additive mix | `src/actors/anim.js` | ACTR-11 | 08 §5, §11 step 6 | `upper`/`lower` layering lets a Ranker walk into range while winding up |
| 20 | ACTR-13 | Foot IK and contact | `src/actors/ik.js` | ACTR-11 | 08 §5.8, §7, §11 step 7 | Feet plant on a 0.45 m step; `actor:footstep` fires on contact |
| 21 | ACTR-14 | Attack timing decomposition | `src/actors/timing.js` | ACTR-12, ACTR-9 | 08 §6, §11 step 8 | wind-up/active/recovery sums to the interval; `active` is never scaled by IAS; `anim:hitframe` fires once |
| 22 | AI-1 | Bestiary data tables | `src/ai/data/bestiary.js` | — | 06 §2, §13 step 1 | Seven archetypes load in Node; base values equal `03-combat-math.md` §9.1 |
| 23 | AI-2 | The `bone_ranker` brain | `src/ai/brains/melee.js` | AI-1, NAV-2 ✅, CMBT-3 | 06 §3.3, §3.4, §13 step 2 | It closes, attacks, deals damage, dies and awards XP |
| 24 | UI-1 | Skeleton, tokens, i18n | `src/ui/index.js`, `src/ui/style.js`, `src/ui/i18n.js` | CORE-9 ✅ | 09 §15 U0 | `ui_clean` shot: 9 nodes; `ui.t('hud.life')` returns both languages |

### 3.3 Order notes you own and should not silently change

- **ACTR-7 is first and alone.** `StatBlock` composition is the root of both
  lanes: CMBT-1 cannot build a packet without it, ACTR-8/9/10 all hang off it,
  and E14 is its own criterion. Nothing runs in parallel with it.
- **CMBT-7 before CMBT-6.** The backlog's numbering is not a dependency order:
  CMBT-6 emits `actor:death`, which is the natural place for other subsystems to
  start hooking in, and you want the on-hit credit paths settled first.
- **TEST-5 last of the sim lane.** Its criterion needs E1–E14 end to end, which
  means every CMBT ticket is closed. Running it earlier just produces a red file
  that everybody learns to ignore.
- **ACTR-6 before ACTR-11/12/13** — poser and animator need a mesh to pose.
- **ACTR-14 is the meeting point**: it depends on ACTR-12 (visual lane) and
  ACTR-9 (sim lane). Do not start it until both lanes have passed it.
- **AI-2 is the milestone's integration test in disguise.** "Closes, attacks,
  deals damage, dies, awards XP" touches nav, actors, combat and XP at once. It
  is where the parts stop being independently green and start being a game. Give
  it room, and expect the first round back to be red.
- **AI-1 and UI-1 are unblocked today** and depend on nothing. Use them to fill
  a lane whenever the other lane is waiting.

### 3.4 Parallelism — the permission and its conditions

`BACKLOG.md` §Scheduling allows `ACTR ‖ CMBT` for M2. Take it, but understand
what actually makes it safe. It is not the prefix — it is **file disjointness**.
Before you launch two subagents at once, all four of these must hold:

1. **Disjoint owned files.** Compare the Files columns literally. In M1 the two
   tickets that shared `src/nav/index.js` were the reason the whole milestone ran
   sequentially.
2. **Only one agent may hold `docs/spec/02-api-contracts.md` at a time.** Every
   ticket has standing permission to append its own API row there (§6 rule 7),
   which makes it the one file *both* lanes can touch. Serialise it: tell the
   second agent to report the row it needs and let you write it, or hold its
   launch until the first lands.
3. **Only one agent may hold `src/main.js` at a time.** M2 registers three new
   subsystems — `combat` (CMBT-1), `ai` (AI-1 or AI-2, your call, state it),
   `ui` (UI-1). Each gets the O-12 two-line permission by name, and they never
   run concurrently.
4. **Only one agent may hold `src/dev/shots.js` at a time** — ACTR-6 and UI-1
   both need to register a shot.

Beyond two lanes, stop. M1 measured it: parallel subagents raised the O-34 flake
rate from ~1/9 to 2/4 and wrecked the "several consecutive green runs" gate item.
O-34 is closed by the test-stage split, but the underlying pressure is not.

**And verify serially.** Two agents may be *writing* at once; you run `npm test`
against one landed change at a time. A green suite that contains two unverified
tickets tells you nothing about either.

### 3.5 Spec slices

Verify each heading with `grep -n` before slicing — line numbers drift, headings
are authoritative.

```bash
# 03-combat-math.md — the spine of this milestone
#   §2.4 resource math L150-238, §4 weapons/speed L287-366, §5 to-hit L367-421,
#   §6 pipeline L422-497, §7 statuses L498-673, §9 monsters L833-945,
#   §10.5 XP award L1097-1139, §12 WORKED EXAMPLES L1343-1610
awk '/^## 12\. Worked examples/,/^## 13\./' docs/spec/03-combat-math.md

# 01-data-model.md: §3 StatBlock L453-624, §4 composition L625-732,
#                   §7 statuses L1104-1194
# 08-characters-visual.md: §2 skeletons L161-313, §3 mesh L314-599,
#                   §5 animation L772-1011, §6 attack timing L1012-1160,
#                   §11 implementation order L1587-1630
# 06-monsters-ai.md: §2 datasheets L122-714, §3 FSM L715-922,
#                   §12 validation L2748-2846, §13 order L2847-2881
# 09-ui.md: §15 implementation order L3068-3097, §2 design system L111-378,
#           §13.1 DOM node budget L2467-2502, §14 i18n L2589-3067
# 12-testing.md: §4.2 worked examples L182-208, §4.4 alloc probes L231-260
```

## 4. Standing constraints carried into M2

Each of these was paid for during M0 or M1 and is recorded in `PROGRESS.md`.
Put the relevant ones **into the brief of the ticket they bind**, by name.

### 4.1 Performance rules found by measurement (all tickets)

- `Math.hypot` allocates — 5.73 B/call vs 0.34 B for `Math.sqrt(x*x + y*y)`.
  Banned in anything marked `Alloc = no`.
- `Map` leaks on never-repeating keys (~456 B/call) even when live entries stay
  at one. Use index arithmetic or parallel typed arrays for pooled or recycled
  state. `Map.prototype.clear()` allocates unconditionally.
- `array.length = 0` tears the backing store; the next write reallocates.
- **A time-based criterion hides an abort.** This is M1's most expensive lesson:
  NAV-2 met "worst-case solve ≤ 1 ms" *by refusing to work* — it fit inside the
  millisecond precisely because it bailed on a node ceiling. Wherever a criterion
  measures time, pair it with a criterion on **work actually done**. In M2 this
  binds ACTR-7 ("recompose ≤ 40 µs" — also assert every one of the ten
  composition steps ran and the result equals E14), TEST-6, and any perf probe.

### 4.2 Spec defects you will hit — resolve these *before* briefing, not during

M2's backlog rows were written against an earlier draft of the specs. Five of
them point at things that are not there. Do not let a subagent discover this and
improvise:

| Ticket | The defect | What you do |
|---|---|---|
| ACTR-4 | Backlog says `src/actors/geom.js`; `08 §3.1` and `§11 step 2` both say **`src/actors/geo.js`** | Use `geo.js` — the spec names it twice, the backlog once. Record as a D-entry |
| ACTR-11 | Backlog says `src/actors/poser.js`; `08 §11 step 5` says **`src/actors/clips.js`** | Pick one, state it in the brief, record the decision. Do not let the agent create both |
| AI-1 | Backlog says `src/ai/data/monsters.js`; `06 §13 step 1` says **`src/ai/data/bestiary.js`** | Same treatment |
| ACTR-3 / ACTR-5 | Bone count: backlog "22–24", `08 §2.3` "**24 bones**", `08 §11 step 1` rigcheck "**22**/16/12/26". Weight normalisation: backlog "sum to **1.0**", `08 §11 step 3` "sum to **255** exactly" | These are contradictions, not ambiguities — **§12 applies, stop and ask the owner.** Do not average them, do not pick the one that is easier to test |
| AI-2 | Backlog cites `06.S01`–`06.S04`. **Those ids do not exist** — `06 §12.2` names its assertions `MB1`…`MB20` | The real criterion for M2 is `06 §13 step 2`'s prose plus `MB2` for `bone_ranker` alone. Rewrite the Done-when in the brief and record it |
| ACTR-6 | "the M2 shot" — `12 §9.1`'s shot set has **no M2 actor shot**; the only M2 entry is `ui_clean` | Register a **dev-only** shot (e.g. `actor_ranker`) in `src/dev/shots.js` for the 40×81 px measurement and do **not** add it to the blessed baseline — `12 §9.1` is the authority on which shots are pinned. File it as an O-entry |

Two tools the criteria assume and the backlog does not create:

- **`tools/rigcheck.mjs` does not exist**, and ACTR-3's and ACTR-5's criteria are
  both "`tools/rigcheck.mjs` says…". Grant ACTR-3 that file explicitly as a
  second owned file, and say so in the brief.
- **TEST-5 needs combat fixtures** (`fixtures.e13()` in `12 §4.2`'s example).
  Grant it `tests/fixtures/combat.js` explicitly alongside
  `tests/combat/examples.test.js`.

### 4.3 Per-ticket bindings

| Ticket | Must be told |
|---|---|
| ACTR-7 | **O-27** in its sharpest form. Also: E14 is the criterion, and E14 prints intermediates — assert the layer stack, not just the final numbers. `01 §4.3` `derive()` fields are *computed*, not contributed; a stat that arrives by both paths is a defect |
| ACTR-8 | `03 §2.4` resource math. Fractional carry must never round up — that is the whole ticket. Rage and Resonance have different accumulation rules; read both |
| ACTR-9 | `actionSeq` is the staleness contract that ACTR-14 and CMBT-3 both depend on. A hit resolved against a bumped `actionSeq` must be dropped, not clamped |
| ACTR-10 | The bitfield is the point: `hasStatus` is a bit test, not a scan. `expireBySource` must remove *exactly* the matching set — write the test that proves a same-status different-source instance survives |
| CMBT-1…CMBT-7 | **The worked examples are not a test, they are the specification.** Every intermediate value `03 §12` prints is an assertion. A ticket that produces the right total by a different route is rejected |
| CMBT-3 | The largest single ticket in M2 (R1–R14 with E9–E13 exact). Expect two rounds. Also **12.A05**: `resolve` over a 12-target `flame_wave` must allocate < 1 B/call — so no per-call arrays, no closures in the hot path |
| CMBT-4 | Diminishing returns ×1/0.6/0.36/0.216 then immunity, and the 4 Hz DoT cadence, are both `03 §7`. The cadence lives on `ctx.time.step`, never on wall clock |
| CMBT-6 | `actor:death` is emitted **only here** — grep the whole tree to prove no other emitter exists before accepting |
| TEST-6 | **O-23**: `12-testing.md` §4.4's probe warms up with **one** call, which is not enough for a polymorphic hot path — on mixed shapes the cost decays 77 → 0.33 B/call as N goes 10k → 4M. Fix by **lengthening the warm-up**, never by loosening the threshold; distinguish a real leak by watching **total** bytes, not the mean. Also: `12.A02` wants "25 monsters in contact", which M2 can only stage by hand-spawning — say how it is staged in the journal |
| ACTR-3…ACTR-6 | Everything in `src/actors/` except the archetype file must stay headless-safe where the spec says so; `check-imports` will catch `three` leaking where it must not |
| ACTR-14 | `08 §6.1`: `hitTick == tick0 + max(2, round(W·60·mult))` and the active window is exactly `round(S·60)` ticks **regardless of IAS**. IAS scaling the active window is the classic bug this ticket exists to prevent |
| AI-1 | Pure data, imports nothing. Base values must equal `03 §9.1` exactly — cross-check both documents, they are separate sources for the same numbers |
| AI-2 | M2's brain is deliberately small: `{dormant, chase, attack, dead}`, **direct steering, no nav** (`06 §13` step 2). Perception, leash, packs, flow-field integration are steps 3–4 and belong to M5. An agent that "helpfully" adds aggro propagation is out of scope and gets sent back |
| UI-1 | `09 §13.1` DOM node budget — the `ui_clean` criterion is **9 nodes**, which is a hard count. `09 §14` i18n: `ui.t('hud.life')` in both languages. No gameplay reads from `ui` |
| every ticket | **O-12**: a ticket registering a new subsystem may add exactly two lines to `src/main.js` — its `import` and its `registry.add(...)`. Nothing else. Grant by name (M2: CMBT-1, AI-1 or AI-2, UI-1) |
| every ticket | **O-27**, the defect class that bit M0 four times and produced O-39 in M1: **a test written before a subsystem encodes "nothing exists yet"**. Do not assert on counts of bodies/statics/subsystems, on an empty stats object, or on a hard-coded pixel. In M1 an entire class of "scope tests" (`typeof nav.smooth === 'undefined'`) had to be deleted, because each was guaranteed to be falsified by the very next ticket |
| every ticket | A public method exists only if `docs/spec/02-api-contracts.md` lists it. Adding one means adding its row in the same ticket. That check is not automated yet, so **you** are the check: diff the table against the new public surface |

### 4.4 Open debts entering M2

Assign each of these to a named M2 ticket in your first report, or tell the owner
plainly that it is being carried into M3. Do not let them drift:

- **O-40** — `src/physics/separate.js` reads `performance.now()` inside the fixed
  step (lines ~177 and ~256) and `check-fixed.mjs` does not see it. M2 has no
  physics ticket, so this needs either a named micro-repair or an explicit
  deferral. It is a determinism hole, which makes deferral a decision, not a
  default.
- **O-35** — `Footprint` is defined twice and differently (`02 §4` vs `07`), and
  the divergence degrades silently.
- **O-36** — `tests/core/boot.test.js` asserts that the whole registered set draws
  zero RNG, which forbids exactly what `ARCHITECTURE.md` prescribes. The first
  ticket that takes `ctx.rng.fork()` in `init()` breaks it. In M2 that is
  **AI-2** (`06 §14`: `ai` forks once in `init()` and never re-forks). Bind the
  rewrite to that ticket.
- **O-37** — `02 §5` re-hashes the static grid twice on a zone change. Carried.
- **O-39** — scope tests are a defect class, deleted in M1. Do not let them come
  back in M2's brand-new directories.
- **`src/ai/data/` is not a `check-imports` root.** `12 §2.1` says every `data/`
  directory is. `src/combat/`, `src/items/`, `src/skills/` are already configured
  and currently report "root does not exist yet"; `src/ai/` is simply missing.
  Add it with AI-1, in the same ticket that creates the directory.

### 4.5 Tooling traps (yours, when verifying)

- **O-26**: `tools/capture.mjs` does **not** rebuild `dist/`. Always
  `npm run build` first, or you will bless a frame from stale code.
- **O-20**: `--test-name-pattern` must come **before** the glob, and the glob must
  be quoted. Flag after glob silently filters nothing.
- **O-28**: `tests/tools/capture.test.js` boots `vite preview` + Playwright at
  file level, so it runs even under a name filter. Target a directory
  (`tests/combat/`) when you want a fast, focused run.
- The perf stage is `--test-concurrency=1` for a reason. If a new test flakes,
  the fix is isolation or the perf stage — **never** a retry, never a loosened
  threshold.

## 5. The loop, one ticket at a time

For each ticket in the order of §3.2, subject to §3.4's lane rules:

**5.1 Confirm readiness.** Deps closed? Owned files free of any concurrent
agent? If the previous ticket is not accepted, you do not start what depends on it.

**5.2 Build the brief.** Extract only the named spec sections. Target
**1500–4000 lines** of context per ticket. Materially more than that means you
took a whole spec — reread the Spec column. For the CMBT tickets, the relevant
slice of `03 §12` goes in verbatim: the agent should be transcribing numbers, not
deriving them.

**5.3 Spawn one Sonnet 5 subagent.** One ticket, one agent, named after the
ticket:

```
Agent(
  name: "CMBT-3",
  description: "Resolve pipeline R1-R14",
  model: "sonnet",
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: <the §6 template>
)
```

Never give one subagent two tickets "while it has the context" — it will start
editing outside its directory and the ownership rule stops protecting anything.

**5.4 Verify it yourself.** The subagent's report is a claim, not a fact. Run §7
in full. "Everything works" plus a red `npm run build` is an ordinary combination
in this project, not an anomaly.

**5.5 Accept or send back.** Accepted → journal entry in `docs/PROGRESS.md` →
next ticket. Not accepted → §8.

## 6. Subagent brief template

```
You implement exactly one ticket of a game engine. Work strictly inside the
files named below. You run on Sonnet 5; the orchestrator will re-verify
everything you claim, by running commands.

## Ticket <ID> — <title>

Files you may touch (and no others):
  <Files column, plus any explicitly granted extra file>

Acceptance criterion (the orchestrator will run this, not eyeball it):
  <Done when column, corrected per §4.2 where it was wrong>

## Engine contract — read this first, it is binding

<full text of docs/ARCHITECTURE.md>

## Specification for this ticket

<only the named sections, extracted from docs/spec/*.md. For any CMBT ticket,
include the relevant worked examples from 03 §12 verbatim.>

## Project state you must respect

<the relevant rows from §4: performance rules, the ticket's specific open
questions O-nn / decisions D-n, the resolved file-name/criterion corrections,
the main.js two-line permission if it applies>

## Rules

1. You own only the files listed above. Editing any other file is a defect and
   will be reverted. If you need someone else's file, say so in the report —
   do not edit it.
2. No new dependencies. `three` only, and gameplay/math code must not import it
   at all: physics, nav, world data, combat and ai run headless in Node, and
   `tools/check-imports.mjs` enforces it.
3. No `Math.random()`. Use `ctx.rng` or your own `ctx.rng.fork()` taken once in
   `init()`.
4. Simulation lives in `fixedUpdate` (60 Hz) and never reads `dt` or the wall
   clock — including `performance.now()`. Presentation lives in `update`.
   Schedule against `ctx.time.step`.
5. Zero allocation per frame. Vectors, matrices, pools, scratch buffers are
   built in `init()`. `Math.hypot` is banned — use `Math.sqrt(x*x + y*y)`.
   `Map` is banned for recycled/pooled state.
6. Gameplay numbers live in `data/`, not in code.
7. A public method exists only if `docs/spec/02-api-contracts.md` lists it. If
   you need a new one, say so in the report and wait — another agent may be
   holding that file. Do not invent API silently.
8. `npm run build` must pass and `npm run capture` must still produce a frame.
   Breaking the boot blocks every other ticket.
9. Do not write tests outside your ticket and do not touch fixtures or blessed
   PNGs.
10. Git: no commits, no pushes, no branch operations. And specifically: no
    `git stash`, `checkout`, `restore`, `clean`, `reset`. Another agent may be
    working in the tree right now. Need a file out of the way? Rename it.
11. Do not assert "nothing else exists yet". Counts of subsystems, bodies,
    statics and exact pixels all change every milestone; assert on the behaviour
    your test exists for. A test whose truth depends on the next ticket not
    existing is a defect, not coverage.
12. If your criterion is a time budget, also prove the work was done. A solver
    that meets a millisecond by giving up early does not pass.

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
   criterion is an assertion id (`03.E13`, `12.A01`, `12.A05`), run the harness
   that produces it — do not settle for "the file exists".
3. **The numbers, by hand, for every CMBT ticket.** Open `03 §12`, pick two
   intermediate values the agent did *not* highlight, and check them yourself
   against the implementation's output. E1–E14 is the gate; a spot check now is
   the cheapest it will ever be.
4. **Tests.** `npm test` (both stages). For perf- or GC-sensitive tickets run it
   **more than once** — M0 and M1 both closed on several consecutive green runs.
5. **Lint.** `npm run lint`. This is the cheapest guard against the most
   expensive mistake in the project: `three` leaking into headless gameplay code
   kills the entire Node test surface. Confirm the root count rises as
   `src/combat/` and `src/ai/data/` appear (it was 6 at the end of M1).
6. **Read the diff.** `git status --short`, then `git diff` over the ticket's
   files. Six things tests do not catch:

   | What | How you catch it |
   |---|---|
   | edits outside the owner directory | `git status --short` shows extra files |
   | importing another subsystem directly | `grep -rn "from '\.\./\(nav\|world\|physics\|actors\|combat\)" src/<dir>` — must be empty, everything goes through `ctx.get()` |
   | `Math.random()` | `grep -rn "Math.random" src/` — exactly one legal hit, in `src/main.js` |
   | allocation in the frame | `new THREE.`, array/object literals inside `update`/`fixedUpdate` |
   | wall clock in the fixed path | `grep -n "dt\|performance.now" <file>` inside `fixedUpdate` — see O-40 |
   | gameplay numbers hard-coded | magic constants where the spec says `data/` |

7. **Independent behavioural probe.** Do not just rerun the subagent's test —
   write your own throwaway check of the claim, in the scratchpad, and compare.
   M0 rejected four tickets this way and M1 two, each time on something the
   subagent's own tests could not see.
8. **Frame.** `npm run build && npm run capture`, then `imagediff` against the
   blessed baseline. **M2 will change the frame** — a Bone Ranker appears in the
   scene from ACTR-6 onward, and `ui_clean` is a new shot. When the frame
   changes, **look at the PNG with your own eyes** before blessing a new
   baseline, and record in the journal that you did. M1's journal notes that the
   frame did *not* change when the prompt predicted it would; check, do not
   assume, in both directions.

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

`docs/PROGRESS.md` is the only file you write (plus the one-line `.gitignore` fix
in §3.1). One row per **accepted** ticket, appended to the existing table,
matching its columns: `ID | date | files | verified how | notes`. A subagent's
report is not a row — your own verification is.

Also keep the rest of the document alive:

- new interface questions go into the O-table with an owner ticket;
- an open question you resolve gets its resolution written down (M2 should close
  O-31, and should either close or explicitly defer O-35, O-36, O-37, O-40);
- every §4.2 spec correction becomes a D-entry, so the next milestone does not
  re-litigate it;
- a performance finding that cost someone a rewrite goes into the rules section;
- update the status line at the top and the milestone-gate table at the bottom.

The document exists so a fresh session understands the state in one minute
without rereading 180 tickets. Write it for that reader.

## 10. The M2 gate

When all 24 tickets are accepted, run the gate — and do not treat it as a
formality:

| # | Check | Source |
|---|---|---|
| ① | `npm run build` green | backlog, definition of done |
| ② | `npm test` green, **several consecutive runs**, both stages | M0/M1 precedent |
| ③ | `npm run lint` green, with `src/combat/` and `src/ai/data/` now live roots | 12 §2.1, O-29 |
| ④ | **`03.E01`–`03.E14` all green, every intermediate value** | 12 §11 — *the* M2 gate |
| ⑤ | `12.A01` — every `Alloc = no` method < 1 B/call over 10 000 | 12 §4.4 |
| ⑥ | `12.A02` — a full `fixedUpdate` with 25 monsters in contact < 1 B/step | 12 §4.4 |
| ⑦ | `12.A05` — `resolve` over a 12-target `flame_wave` < 1 B/call | 12 §4.4 |
| ⑧ | `ui_clean` captured, reviewed by eye, and **committed** to the baseline | 12 §11, §9.1 — needs §3.1 done |
| ⑨ | End to end: a mob damages the player, the player dies and respawns | IMPLEMENTATION_PLAN §9 |
| ⑩ | `12.P08`, `12.P09`, `12.D07` still green — M1 must not regress | M1 gate |

Item ⑨ is the one that is easy to fake and easy to skip. Run it as a real
scripted session, not as three unit tests that each cover a third of it.

Red gate = milestone not closed. There is no "we will fix it in M3": M3 is loot,
and loot is affixes multiplying into exactly the damage pipeline this milestone
is supposed to have pinned to the last digit.

**When the gate is green, stop.** Do not start M3. Report to the owner: tickets
closed, gate results item by item, what was hard, which specs proved wrong or
ambiguous, what should be revisited in the plan. M3 starts on a direct order,
exactly as M1 and M2 did.

## 11. Git

**No commits. No pushes.** Not by you, not by subagents. Take the work to
"changes are ready" and stop. The owner grants commit permission separately and
freshly each time; permission from a previous turn does not carry over. No
`rebase`, `reset --hard`, `merge`, branch/tag deletion.

**Also forbidden: `git stash`, `checkout`, `restore`, `clean`, `reset`** —
anything that touches the working tree as a whole. M0–M1 are committed now, so
the blast radius is smaller than it was, but M2's in-flight work is not, and with
two lanes running there may be two tickets' worth of uncommitted code in the tree
at once.

The `.gitignore` fix in §3.1 is a file edit, not a git operation, and it is the
single exception to "PROGRESS.md is the only file you write".

When M2 closes, say the work is ready and offer to commit — then wait.

## 12. Stop and ask the owner when

- two documents require **incompatible** things — a contradiction, not an
  ambiguity. §4.2's bone count (24 vs 22) and weight normalisation (1.0 vs 255)
  are already on this list; find the rest before a subagent does;
- a ticket needs a **number that no spec provides** — never invent one, that is
  the one reliable way to diverge from the harness;
- a worked example's arithmetic does not close. If E-something cannot be
  reproduced *and* the implementation looks right, the spec may be wrong — that
  is a finding, not a licence to adjust the expected value;
- the gate stays red after three attempts;
- something would add **game content** (a skill, a monster, an item) beyond the
  single `bone_ranker` M2 names — the plan forbids that before M7;
- the work would go outside the backlog.

Do not stop for routine: private function names, file layout inside your own
directory, field order. Decide and move.

## 13. Reporting

Per ticket, short:

> `CMBT-3` accepted. `src/combat/resolve.js`. `npm run build` green, `npm test`
> 702/702 across both stages, E9–E13 exact including all intermediates (I
> re-derived E12's mitigation order by hand and it matches), `12.A05` 0.31 B/call
> over 10 000. Next: `CMBT-7`.

Per milestone, a table: tickets, gate results, what surfaced, what to revisit.
Do not narrate diffs. The owner tracks state and blockers.

## 14. Start here

1. Read the five items in §2 — including E1–E14 in full, before anything else.
2. Clear §3.1 (the `.gitignore` blocker) and record it.
3. Walk §4.2 and confirm each spec defect against the current files. Bring the
   two genuine contradictions (bone count, weight normalisation) to the owner
   **now**, in your first report — they block ACTR-3, and ACTR-3 blocks the whole
   visual lane.
4. Create tasks (`TaskCreate`) for the 24 M2 tickets in the §3.2 order, so
   progress is visible.
5. Report the plan: 24 tickets, ACTR-7 alone first, then two lanes
   (`sim: ACTR-8/9/10 → CMBT-1…7 → TEST-6 → TEST-5` and
   `visual: ACTR-3 → ACTR-4 → ACTR-5 → ACTR-6 → ACTR-11 → ACTR-12/13`) meeting at
   ACTR-14, with AI-1/UI-1 as lane filler and AI-2 as the integration test.
6. Launch `ACTR-7`.
