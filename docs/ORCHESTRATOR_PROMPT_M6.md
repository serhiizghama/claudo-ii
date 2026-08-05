# Orchestrator start prompt — milestone M6

Run on **Opus 5**. Copy everything below the separator into the first message of
a fresh session. Subagents run on **Sonnet 5**.

`ORCHESTRATOR_PROMPT.md` (M0) remains the general standing order.
`ORCHESTRATOR_PROMPT_M1.md` … `_M5.md` are closed precedents. This file is the
specific assignment for M6.

---

You are the **orchestrator** for milestone **M6 — Town, quest, boss** of the
browser ARPG *Claudo II: Lord of Instruction*. This is the milestone the plan
calls **first playable**.

You do not write game code. You read the specifications, slice M6 into its
already-defined tickets, hand each ticket to a **Sonnet 5** subagent, verify the
result yourself by running commands, and only then move on. One ticket, one
agent, one verification, then the next — until all **18** tickets are closed and
the M6 gate is green.

Your value is execution discipline and verification, not invention.

Each milestone has failed differently. M2 was arithmetic: fourteen worked
examples had to reproduce to the last digit. M3 was distribution: a wrong weight
produced a *plausible* histogram. M4 was interaction: every part correct, the
composition wrong. M5 was statistical: it works on the seed the agent looked at.
**M6 is the sequential milestone**, and it fails in a sixth way. Nothing here is
proved by a step; it is proved by a *session*. A quest flag written twice, an XP
award replayed on a re-entered zone, a save that loads but not the thing you
saved, a boss phase that arms its enrage clock during its own invulnerability, a
reward granted a second time by a reload — every one of these passes its unit
test and kills the campaign. The defect shape is: **it works when you test the
step and fails when you play the game.** That is why the gate's first item is one
real session end to end, why §7 tells you to drive `boot()` rather than to
re-run the ticket's suite, and why a subagent that shows you a green
`quest.test.js` has shown you a step, not a game.

The second thing that makes M6 different, and it is not background: **M5 did not
close.** Four of its twelve gate items are red on the day this prompt is written.
One of them — ⑪, the player who freezes in combat — makes the M6 gate literally
unreachable, because a character who cannot fight cannot kill Molgrim. §1.1 is
your phase 0, and two of its four items are the first two tickets you execute,
before anything M6 builds.

**The blockers are already cleared — read §4.2 before you brief anybody, but do
not re-open it.** Twenty divergences were investigated before this session and
are settled here as **D-94…D-113**; journal them on first contact. §12 still
applies to anything *new* you find, and doc `13-progression-lore.md` has already
proved internally inconsistent in five places, so expect more.

---

## 1. Where the project stands right now

**M4 is closed** 21/21, gate green on all twelve items, 2026-08-05
(`PROGRESS.md:5111`). **M3** 27/27, **M2** 24/24, **M1** 14/14, **M0** 19/19.

**M5 — Zones and bestiary: all 18 tickets accepted, gate NOT green.** Every
ticket has a journal row (`PROGRESS.md:452–606`; ten of them reconstructed after
the fact under D-88, which is the second time that debt has been paid). The code
is committed on `main` at **`8b8f6de`** and the working tree was clean when this
prompt was written. Confirm with `git log --oneline -3` and `git status --short`
before you touch anything.

### 1.1 M5's residue — your phase 0, before ticket 3

Four gate items are red. They are not bookkeeping; two of them are engineering
and they are tickets 1 and 2 of this milestone.

**(a) Item ⑪ — the player freezes in combat. `O-145`, unassigned.** The measured
result (`PROGRESS.md:5574–5604`): a real zone, a real 7-monster pack at 27.2 m,
each class with its first attacking skill, orders issued through the real
`moveOrder`/`castOrder` — `ravager / emberwright / runeblade: 0 из 7 убито за
120 с, 0 кастов`. The player walks 36 m and stops dead at (−18.6, −16.4) with
navigation measured healthy at that point: `regionMe=0 regionTgt=0
connected=true walkable=true snap(target)=ok refusals=0 pending=0`, and 54
re-issued orders producing no movement. **The stall is behind navigation** — in
player movement or in monster bodies; the recorded candidate is **O-105** (an
attacking monster has no steering avoidance and bodies press to 0.084 m). The
previous orchestrator refused to assign it without a measurement, and it also
recorded that two drafts of its own probe were wrong before this one. **This is
micro-ticket `PLYR-11`, ticket 1, and you measure before you grant a file**
(D-95). Its probe was deliberately **not** committed — a red test in the suite
breaks gate item ② — so it lives only in that session's scratchpad. You will
have to rebuild it. Build it once, well, and have the ticket commit it green.

**(b) Item ④ — `mapgen.mjs` is 17 pass · 5 fail over 1826 layouts.** Three of the
five have one cause: **O-107**, the Ashen Wastes entry region is fragmented and
its descriptor is internally inconsistent. It is why `I1` fails on the Wastes,
why 41 chests still land outside the entry region after O-140 saved 518 of 559,
and why `I2` sits at 566/600. The remaining two are **O-138** (`I1` on Bonereach
— a real generator defect, a wall and a column, after the "cell-boundary
artefact" reading was withdrawn) and **`I8` on the Wastes** (D-83/D-90 ruled the
Altar's a counting `NOTE`; the Wastes stayed `FAIL`). **`I9` cannot be judged at
all** — `07` §7.3 reads `fogOpacityAt` from `src/sky/`, which does not exist
until M8. **This is micro-ticket `WRLD-13`, ticket 2** (D-96), scoped to O-107
and O-138. `I8`-Wastes and `I9` go to the owner in your first report with a
recommendation; do not silently absorb them.

**(c) Item ⑧ — the corridor check.** `O-147`: the previous owner ruling ("the
clause does not apply while engaged mass is present") was built on a summary that
turned out to be false. Measured: a real generated corridor breaks into a chain
**9 times, 4 of them at ≥ 3 members**, the first at four members, not two; the
fixture corridor 27 times, 15 at mass. The counter is printed, the assert was
**not** placed, and the threshold was **not** tuned — correctly. Closing it needs
either a formation fix in `src/ai/crowd.js` (the tail catches up or the head
slows) or an accepted deviation. **That is an owner decision, not yours.** Put it
in your first report; if the owner picks the fix, it is micro-ticket **`AI-13`**
and you schedule it in the AI lane after AI-11. Note also **O-104**: real
Bonereach corridors measure **4.0 m**, not the 3.0 m the criterion names.

**(d) Item ⑥ — `balance.mjs --monsters` is 65 pass · 3 fail.** The trail is
59/7 → 61/7 → 63/5 → 64/4 → 65/3 across four sessions of real fixes and two
owner rulings (O-143 MB16, O-146 MB7). The three that remain are spec-arithmetic
conflicts, not code defects — the recorded candidates are MB8 against `06` §6.4,
MB9's floor, and MB2's wording (`PROGRESS.md:4407–4413`). **Name the actual
three in your first report** by running the harness, and take them to the owner
as fix-or-accepted-deviation. Do not narrow an assertion to make a line green;
that class of error was caught five times in one session and is written up as
such.

**(e) The status line and the gate table are stale — again.** `PROGRESS.md:124`
still says «M5 … 0 из 18 тикетов принято», which contradicts the eighteen rows
below it, and the gate table's M5 row (`PROGRESS.md:1535`) still says «ИДЁТ».
There is **no M5 gate table in `PROGRESS.md` at all** — the twelve items live in
`ORCHESTRATOR_PROMPT_M5.md:1128–1141` and their results are scattered through
prose. Write the M5 gate table into `PROGRESS.md`, item by item, with the honest
verdict for each; fix the status line. This is the third milestone in a row that
inherits a journal disagreeing with its own repository, and the third time it is
being repaired instead of prevented.

**Report all of §1.1 in your first message, then keep going.** You do not wait
for an answer to start `PLYR-11` — only ⑧'s variant (б), the three `--monsters`
failures, `I8`-Wastes and `I9` need the owner, and none of them blocks ticket 1.

### 1.2 Measured baseline, 2026-08-05 at `8b8f6de`

Re-measure it yourself in §14 and put the real numbers in your first report —
this is how you notice later that a ticket quietly deleted somebody's tests.

```
build      → green, 896 ms, one chunk (vite's >500 kB warning is not a gate)
test:unit  → tests 2460  pass 2460  fail 0
test:perf  → tests  196  pass  196  fail 0   (--test-concurrency=1, ~5 min)
lint       → check-imports PASS, 20 roots, 119 files
             check-fixed   PASS, 134 Fixed=N contracts
balance    → --skills   RESULT: PASS   413 pass · 0 fail
             --monsters  RESULT: FAIL   65 pass · 3 fail
mapgen     → FAIL, 17 pass · 5 fail, 1826 layouts, 12.D02 green (12/12 seeds),
             layoutHash bcdbb405c8149246 reproduced across processes
lootsim    → 41 checks passed · 0 failed (12.D03 / 12.D08)
shots      → 10 registered, 8 blessed, all diffPixels=0
             (boot_clean, ui_clean, inventory_full, skill_tree_ravager,
              wastes_seed_a, wastes_seed_b, bonereach_hall, dense_combat)
```

Budget for the perf stage: five minutes per acceptance × 18 tickets × reruns is
real time. M6 adds three harnesses of its own — `save-fuzz.mjs` (5 000
round-trips + 8 000 mutants), `balance.mjs --boss` and `playtest.mjs` (a real
browser build driving a full campaign on three seeds) — and the last of those is
the slowest thing in the project by an order of magnitude. Plan around it.

**Three perf probes are known-unstable and all three are open**: O-85 (the
`12.A01 moveBody` assert flakes inside the concurrent unit stage; alone it is
30/30 three runs running), O-93 (`tests/ui/target.perf.test.js` sits on its
threshold), O-117 (`perception.perf` and `crowd.perf`, "два последовательных
прогона одной суиты валят разные пробы", margin 1.0874 against a `< 1` threshold
at a typical 0.72 reading). The recorded conclusion is that **allocation
thresholds in this project are set too close to the measurement**. The house rule
holds without exception: **fix isolation or the measurement, never the threshold,
never a retry.**

### 1.3 What exists today

- `src/core/`, `src/render/`, `src/physics/`, `src/nav/` — as at the end of M5
- `src/world/` — `index.js`, `zone.js`, `transition.js`, `raster.js`,
  `testmap.js`, `spawn.js`, `height.js`, plus **`gen/`** (ridgewalk, wastes,
  bonereach, altar) and **`build/`** (the `three`-side construction, with the
  pointed `three` exception recorded as D-78), and `data/zones.js`. **No town:
  `src/world/data/last_bastion.js` and `src/world/build/town.js` do not exist,
  and neither does `src/world/interact.js`.**
- `src/ai/` — `index.js`, `perception.js`, `nav.js`, `crowd.js`, `spawn.js`,
  `rank.js`, `corpse.js`, `brains/` (six), `data/bestiary.js`,
  `data/affixes.js`. **No `boss.js`, no `data/molgrim.js`, no `difficulty.js`.**
  `ai.spawnBoss` is unimplemented and `store.stats.bossPointsSkipped++` counts
  every `kind:'boss'` spawn point it walks past — that counter is AI-10's entry
  point (`src/ai/spawn.js:54`, `:789`)
- `src/player/` — `index.js`, `move.js`, `cast.js`, `progress.js`,
  `data/progression.js` (95 lines: **only `XP_TOTAL` and `XP_TABLE`** —
  `OPENING_RAMP`, `CLASS_START_KIT` and `QUEST_XP` are all missing). **No
  `quest.js`, no `create.js`, no `death.js`, no `reward.js`, no `data/quests.js`**
- `src/save/` — `index.js` (142 lines, attaching only `validate()` and `meta()`;
  its header names fifteen contracted methods as deliberately absent, all
  attributed to SAVE-2/SAVE-3) and `schema.js` (680 lines, **`SCHEMA_VERSION = 1`,
  `INVARIANT_COUNT = 15`**, invariants 1–15 implemented one function each).
  **No `store.js`, no `migrate.js`, no `migrations/`, no save fixtures anywhere**
- `src/ui/` — 15 files, UI-1…UI-11 shipped. **No `panels.js`, no `screens.js`.**
  `i18n.js` carries **302 EN and 302 RU keys** and **no `adj`**
- `src/items/`, `src/combat/`, `src/actors/`, `src/skills/`, `src/materials/` —
  as at the end of M5
- `tools/` — `check-imports`, `check-fixed`, `capture`, `imagediff`, `rigcheck`,
  `lootsim`, `iconbench`, `balance`, `mapgen`. **No `save-fuzz.mjs`, no
  `playtest.mjs`**, and no `baseline.mjs`/`profile.mjs` (12 §5 lists them; they
  are M9's and are not funded here)
- `tests/fixtures/` holds `combat.js` and `shots/` only. **There is no fixture
  directory for saves or for nav**, and both `01` §10.4 and `07` §2.6 assume one

`npm test` is `test:unit && test:perf`. Since D-11 a new test file lands in the
perf stage **by name**: anything matching `*.perf.test.js` is picked up by
`test:perf` and excluded from `test:unit`. When you brief a ticket whose tests
assert a time, an allocation or a frame, tell it to name the file
`<thing>.perf.test.js`. You do not edit `package.json`.

**One finding you must carry into every brief: O-128 — no actor renders in the
application.** `actor.view.root` is only ever assigned `null`; a live census
during M5 read `monsters 52, monstersWithRoot 0, sceneTotalObjects 25`. The
backlog owner is the `ACTR-16…ACTR-19` / `MATL-3` lane, which sits in **M7/M8**.
This is not M6's to fix and it is M6's to work around: `boss_phase_2` cannot show
Molgrim, `dense_combat` did not change when monsters were added to Bonereach, and
**no visual check in this milestone proves anything about actors**. Say so in
every shot description you bless (D-113).

The owner has given the go-ahead for M6. The stop-rule in `PROGRESS.md` is
satisfied by this message.

## 2. Read this first — and only this

`docs/` holds ~41 000 lines of specification. Reading it all is the failure mode,
not the diligent path. Your core engineering job is to hand each subagent exactly
the slice it needs.

Read now, in full:

| File | Lines | Why |
|---|---:|---|
| `docs/ARCHITECTURE.md` | 283 | the engine contract. **Every** subagent gets this verbatim, no exceptions |
| `docs/PROGRESS.md` — the header block, the O-table (`:1046–1122`), the M5 findings O-95…O-147 and D-73…D-93 | ~900 | six milestones of traps, priced in blood. M5's tail (`:5111–5676`) is where the four red gate items live |
| `docs/BACKLOG.md` — "How to read a ticket", "Scheduling", the **M6** table (L240–262) | ~60 | 16 of the 18 tickets you are executing — `PLYR-11` and `WRLD-13` are not in it, see §3.2 |
| `docs/spec/13-progression-lore.md` §12 (L1785–1811), §2 (L378–519), §3 (L521–649) | ~350 | the quest machine, the L-rows, and the only document that says what "completable" means |
| `docs/spec/06-monsters-ai.md` §7 (L1646–2186), §11 (L2713–2811), §12.2 (L2830–2854), §13 rows 10–11 (L2930–2931) | ~700 | the boss in full, the tiers, and the assertions that gate them |
| `docs/spec/12-testing.md` §5.4 (L390–406), §5.6 (L421–441), §6 (L445–476), §9.1 (L546–565), §11 M6 row (L643) | ~120 | the gate you must turn green |

Everything else — `docs/spec/01`…`13` — you read **pointwise**, only the sections
a specific ticket names. Do not load a whole spec "to get oriented".
`05-skills.md` (4158 lines) is M4's document and `04-items.md` (2520) is M3's;
if you find yourself reading either, you have drifted.

**Three notational traps, read before you slice anything.**

First, **`06 §13.n` is a row of a single table, not a markdown subsection** —
D-62, still binding, still the most expensive five minutes in the project.
`06` §13 is one table at L2914–2945; `grep -n "### 13.10"` finds nothing. Row 10
summarises §7's 540 lines in one clause. Quote the row **and** hand over the real
section; §3.5 maps both. `07` §12 has the same shape (row 3 is the town).

Second, ids are written bare inside their owning document and prefixed from
outside: `MB1`…`MB20` = `06.MB01`…`06.MB20`, `I1`…`I9` = `07.I01`…`07.I09`. Say
both spellings in any brief that cites one. And note that `06`'s bare form is
`MB5`, never `MB05` — `BACKLOG.md`'s `06.MB01` style matches nothing in the
document it cites.

Third — new this milestone — **`13-progression-lore.md` numbers its
implementation steps `L0`…`L12`, and they are rows of the §12 table.** They are
not sections, they are not assertions, and six of the thirteen have no backlog
ticket at all (D-102). `13.P01`–`13.P04`, which the M6 gate line requires, **do
not exist anywhere in the document** — doc 13 owns the reserved letter `P`
(`12`:149) and numbers nothing with it. They are defined in §4.2 D-103.

## 3. The M6 work list

**18 tickets:** the backlog's sixteen — `WRLD-11`, `WRLD-12`, `PLYR-5`…`PLYR-9`,
`AI-10`, `AI-11`, `SAVE-2`, `SAVE-3`, `UI-12`, `UI-13`, `UI-14`, `TEST-10`,
`TEST-11` — plus **`PLYR-11`** and **`WRLD-13`**, two micro-tickets created by
D-95 and D-96 to give M5's two engineering-shaped gate failures an owner. A
nineteenth, **`AI-13`**, exists only if the owner rules for the crowd fix in
§1.1(c); do not create it on your own authority.

`BACKLOG.md` §Scheduling permits `WRLD ‖ AI ‖ ITEM ‖ SKIL ‖ UI` for M5–M7. M6 has
no `ITEM` or `SKIL` work but adds `PLYR`, `SAVE` and `TEST` lanes the table never
contemplated. §3.4 states the real permission, and it is tighter than the
backlog's blessing suggests.

### 3.1 What was cleared before you started

Twenty divergences were investigated before this session. All are binding; §4.2
carries the reasoning you need to put in a brief.

| Ruling | What it settles | Binds |
|---|---|---|
| **D-94** | M5's residue is your phase 0; M5 does not close by declaration. Four red items, four dispositions | before ticket 3 |
| **D-95** | The combat freeze is micro-ticket **`PLYR-11`**, first in the order — and you **measure before you grant the file** | PLYR-11 |
| **D-96** | The Wastes entry region is micro-ticket **`WRLD-13`**: O-107 is one cause behind `I1`, `I2` and 41 unsnapped chests; O-138 is a second, real generator defect | WRLD-13 |
| **D-97** | The town is `07` **§2**, not §3; and the paths are `src/world/data/last_bastion.js` + `src/world/build/town.js`, **narrowing D-65** | WRLD-11, WRLD-12 |
| **D-98** | The sealed gate is **Bonereach's**, not the town's; the "chest" is the stash chest; `NpcDescriptor` is pinned to `07` §2.2's `NPCS` shape | WRLD-12 |
| **D-99** | "310 footprints, `nav.rebuild` 0.54 ms" are **model estimates**; WRLD-11's real gates are the ASCII map, the fixture, `regionCount === 1` and the p95 budget | WRLD-11 |
| **D-100** | `town_spawn` does not exist. The respawn tag is **`town_start`** | PLYR-8 |
| **D-101** | Doc 13's step numbering contradicts itself in five places. **§3.2 is authoritative**: seven steps, gate opens at `step >= 3` | PLYR-5, WRLD-12 |
| **D-102** | `13` §12's rows **L3, L4, L8, L9, L10, L11 have no backlog owner** — assigned here, by name | six tickets |
| **D-103** | `13.P01`–`13.P04` do not exist; defined here from doc 13's own provable claims. `balance.mjs --progression` is a second micro-scope inside PLYR-6 | PLYR-6, PLYR-8, TEST-11 |
| **D-104** | UI-14 is not "473 keys": ~100 rows of `09` §14.3 never shipped and 58 shipped keys are renames. It is the critical path and lands **before** UI-12 | UI-14, UI-12 |
| **D-105** | `setScreen` has **six** screens; `09`:3113 is stale. UI-13 renders `reward_choice`, PLYR-9 owns the grant behind it | UI-13, PLYR-9 |
| **D-106** | Save layout: `src/save/migrate.js` (one file), fixtures under `tests/fixtures/saves/`, **`SCHEMA_VERSION` stays 1**, `cursorItem` is an optional default-null field, `INVARIANT_COUNT` becomes **17** | SAVE-2, SAVE-3, TEST-10 |
| **D-107** | The name pattern is the **Cyrillic-extended** one; `01`:1534's ASCII-only line is stale | PLYR-7, UI-13, SAVE-2 |
| **D-108** | AI-10's gates are **MB5, MB5b, MB15** plus `balance.mjs --boss`; seven named behaviours, six of which draw; `06` §7.9's per-class `U`, never `03`'s flat 0.88 | AI-10 |
| **D-109** | AI-11 imports `+0/+12/+22` from **`src/world/spawn.js`**, not `combat`; **merges** into the `'difficulty'` stat layer; **MB6 stays a loud skip tagged M7**; `mapgen --difficulty` becomes implementable and is a named micro-scope | AI-11 |
| **D-110** | Four shots, four owners: `town_overview` → WRLD-11, `altar_arena` + `boss_phase_2` → AI-10, `vendor_open` → UI-12 (deferred from M3 by D-22 and never picked up) | three tickets |
| **D-111** | **`TEST-10` is `tools/save-fuzz.mjs`.** M5's contingency that would have used the id never fired; the id is free | TEST-10 |
| **D-112** | TEST-11 owns `tools/playtest.mjs` only. An assertion that cannot be measured reports **`skip`, loudly**, naming M9 — never a fake pass | TEST-11 |
| **D-113** | O-128 is still open: no actor renders. Every M6 shot description says what the frame does **not** contain | WRLD-11, AI-10, UI-12 |

Your job with these is to **verify, not re-litigate**: confirm each still matches
the current files, then brief from them. If one turns out not to match reality,
that is a finding worth a message — but the default is that they hold.

### 3.2 The tickets

Files below are the **corrected** paths (§4.2 D-97, D-106). Numbering is
execution order, not backlog order.

| # | ID | Title | Files | Deps | Spec | Done when (corrected) |
|---:|---|---|---|---|---|---|
| 1 | **PLYR-11** | **The combat freeze** (new, per D-95) | **one file, granted after your measurement** — candidates `src/player/move.js`, `src/ai/crowd.js`, `src/physics/separate.js` | — | O-145, O-133, O-105; 11 §3, 06 §8.3 | the O-145 scenario, rebuilt and committed **green**: a real zone, a real 7-pack at 27.2 m, each of the three classes with its first attacking skill, orders through the real `moveOrder`/`castOrder` — **each class kills ≥ 5 of 7 inside 120 s and casts more than zero times**; the actor never stops for more than 2.0 s while a reachable order is live. The probe is a committed test, not a scratchpad script. **M5's gate item ⑪ is re-run and recorded** |
| 2 | **WRLD-13** | **Wastes entry region and the Bonereach `I1` pair** (new, per D-96) | `src/world/gen/wastes.js`, `src/world/data/zones.js` (**granted — the Wastes descriptor row only**), `src/world/gen/bonereach.js` | WRLD-6 ✅, WRLD-7 ✅ | 07 §3.2 R8–R10 (L775–866), §7.1 (L1663–1688), O-107, O-138 | the Wastes entry region is one connected component containing its entry and its exit; **`I1` green on both zones**, **`I2` ≥ 594/600** (the 41 chests outside the entry region were O-107's, not the snapper's); `mapgen` prints a strictly better line than **17 pass · 5 fail** and you state which two failures remain and why. Do **not** touch `I8`/`I9` — they are owner items |
| 3 | UI-14 | i18n dictionary and `ui.adj` | `src/ui/i18n.js` | UI-1 ✅ | **13 §12 L0 (L1791)**, **13 §9 (L1109–1432)**, **13 §10.4 (L1502–1582)**, 09 §14.1–§14.3 (L2591–3066) | the boot check of `09` §14.1 reports **zero missing**; `ui.t('dlg.veren.greet.1')` returns both languages; `ui.adj('monsterAffix.burning','f')` → `Огненная` and `('...','x')` falls back without throwing; **the 2 688 × 4 agreement assertion of `13` §10.4 passes in Node under 40 ms**; the shipped dictionary reaches `09` §14.3's 344 **plus** `13`'s 473, with the 58 renamed keys **reconciled, not duplicated** (D-104); `lootsim` produces identical index sequences under `EN` and `RU` |
| 4 | PLYR-6 | Progression tables **and `balance.mjs --progression`** | `src/player/data/progression.js`, `tools/balance.mjs` (**second micro-scope, D-103 — granted explicitly**) | CMBT-6 ✅ | **13 §12 L1 (L1792)**, **§1.2 (L151–198)**, §1.3 (L199–221), **§1.4 (L222–259)**, §1.5 (L261–292) | `XP_TABLE` **imported from `combat`, never copied**; `OPENING_RAMP`, `CLASS_START_KIT`, `QUEST_XP` present and pure-data, Node-loadable; `node tools/balance.mjs --progression` reproduces §1.4 and §1.5 **to the unit** and asserts the three boss levels **13 / 24 / 30**; **`13.P01` and `13.P02` green** as defined in D-103 |
| 5 | WRLD-11 | Last Bastion layout and build | `src/world/data/last_bastion.js`, `src/world/build/town.js`, `src/dev/shots.js` (**granted, one shot**) | WRLD-1 ✅, MATL-1 ✅ | **07 §2 (L285–592)** — §2.2 L317–454 and §2.3's map L456–521 go in **verbatim** — plus §12 row 3 (L2560), §6.5 (L1578–1596) | `tools/mapgen.mjs --zone last_bastion --ascii` reproduces the §2.3 map **character for character**; walkable cells equal the committed fixture **± 0**; **`regionCount === 1`**; the seven frozen arrays load with `PROPS[i].n` summing to `POINTS.length / 5` as a **load-time** failure (rule 5); nav build **p95 ≤ 2.0 ms** — 310 footprints and 0.54 ms are estimates, not asserts (D-99); the instance is built once and never disposed. **Registers, captures, eyeballs and blesses `town_overview`** |
| 6 | AI-10 | Molgrim: three phases **and `balance.mjs --boss`** | `src/ai/boss.js`, `src/ai/data/molgrim.js`, `tools/balance.mjs` (**second micro-scope, D-108**), `src/dev/shots.js` (**granted, two shots**) | AI-9 ✅, WRLD-8 ✅ | **06 §7 in full (L1646–2186)** — §7.1, §7.3–§7.7's pattern tables and §7.9 go in **verbatim** — **§14.3 (L2980–2989)**, §13 row 10 (L2930); **07 §5.3 G1–G6 (L1313–1414)** | `ai.spawnBoss` fills the Altar's `kind:'boss'` point (`bossPointsSkipped → 0`); **`boss:phase` at spawn with `phase: 1`** and at each transition; the 1.5 s invulnerable walk-to-centre, the 0.20 s global hit-stop, the paused enrage clock; **MB5** (TTK 60.0–90.0 s for all three builds), **MB5b** (< 150 s), **MB15** (per-phase uptime within ±0.05 of §7.9's 0.848/0.893/0.833) via `node tools/balance.mjs --boss`; **seven named behaviours, six of which draw** (D-108); the eight summon and twelve teleport anchors are **read from the arena, not re-derived**. **Blesses `altar_arena` and `boss_phase_2`** |
| 7 | WRLD-12 | NPCs, stash chest, portal pad, gate sealing | `src/world/interact.js` | WRLD-11 | **07 §2.2 (L381–409)**, **§9.3 (L2179–2202)**, 02 §5 (L415, L420–421), **13 §3.3 (L553–588)** | the four NPCs and three interactables of §2.2 load with the `NPCS` shape as `NpcDescriptor` (D-98); `interactableAt` returns the **nearest enabled** one, ties by lower id, through a shared scratch record — **`Alloc = no`, asserted**; `setExitSealed('bonereach','gate',true)` flips exactly one `Interactable` and `enabled: false` hides the prompt in favour of `prompt.gateSealed`; the town's own `gate_exit` is never sealed by anything |
| 8 | PLYR-7 | Character creation and starting kits | `src/player/create.js` | PLYR-6, ITEM-11 ✅ | **13 §12 L7 (L1798)**, **§4.3 (L685–741)**, §4.4 (L743–753), 01 §10.3 (L1626–1627) | three characters created, each holding **precisely** the §4.3 kit — the table goes in verbatim, including the pre-spent hotbar point; `save.validate()` passes **invariants 3 and 4** on all three, with invariant 4's `− Σ classStartSkills` term (the amendment exists *because* every class pre-spends); the name pattern is the **Cyrillic-extended** one (D-107) and a Cyrillic name round-trips through `localStorage` |
| 9 | PLYR-8 | Death, respawn, XP penalty **and the level cap** | `src/player/death.js`, `src/player/progress.js` (**granted — the `experience` clamp only, D-102 L11**) | PLYR-4 ✅, PLYR-6 | **11 §6.7 (L1143–1164)** and **03 §10.6 (L1140–1152)** — *not* `11 §8*, which is Level up (D-102) | `loss = round(0.05 × (XP_TOTAL(clvl+1) − XP_TOTAL(clvl)))`, **only at `clvl ≥ 5`**, `experience` floored at `XP_TOTAL(clvl)` — **238 at clvl 10, 1 383 at clvl 29, 0 below 5, 0 at 30**, never a level loss; respawn requests `last_bastion` / **`town_start`** (D-100) at **30 % life, 30 % mana, secondary emptied**, items kept, no corpse run; `world.closePortal` on death, so the field zone is never retained; **`13.P03` green** |
| 10 | AI-11 | Difficulty tiers | `src/ai/difficulty.js`, `tools/mapgen.mjs` (**third micro-scope, D-109 — `--difficulty=` only**) | AI-10 | **06 §11 (L2713–2811)**, esp. **§11.3's behaviour table (L2752–2763)**; §13 row 11 (L2931); **03 §10.2 (L1009–1032)** | the seven per-tier behaviours of §11.3 land exactly as printed; `immunityValue(tier)`; `+0/+12/+22` **imported from `src/world/spawn.js#DIFFICULTY_MLVL_OFFSET`**, never redeclared (D-109); tier stats **merge into** the `'difficulty'` layer, never replace it; **MB2, MB3, MB4, MB5, MB5b, MB7, MB8 re-run at Trial and Renunciation, MB11 at every tier**, and **MB6 reports `skip` loudly, naming M7**; `mapgen --difficulty=` stops exiting 2 |
| 11 | PLYR-5 | Quest state machine **and the gate call site** | `src/player/quest.js`, `src/player/data/quests.js` | WRLD-12, PLYR-6 | **13 §12 L2 (L1794) and L4 (L1796)**, **§2 (L378–519)**, **§3.2 (L531–551)**, §3.3 (L553–588) | all **seven** steps of §3.2 drive from a headless script and assert the exact state chain; `advanceQuest` is **monotone**; **replaying `zone:ready { bonereach }` five times awards 3 400 XP once**; quest XP is `grantXp(amount, 0)`, never scaled by `levelPenalty`; `player` calls `world.setExitSealed` on **`quest:update` and `zone:ready`** (L4), and a character who never spoke to Kaira is refused at the Gate; step numbering follows **§3.2 and nothing else** (D-101) |
| 12 | SAVE-2 | localStorage, 3 slots, stash **and invariants 16/17** | `src/save/store.js`, `src/save/index.js` (**granted — wiring only**), `src/save/schema.js` (**second micro-scope, D-102 L3**) | SAVE-1 ✅, PLYR-5 | **01 §10.1–§10.3 (L1508–1642)**, **13 §2.4 (L469–501)** | the four key families match `claudo2.save.v1.*` exactly; three slots, `null` for empty; the shared stash; autosave on the six triggers of §10.4 rule 10 and every **60 s**, **writing to `…tmp` and swapping**; a **mid-drag autosave keeps `cursorItem`** as an optional default-null field with no `SCHEMA_VERSION` bump (D-106) and invariant 8's uid uniqueness counts it; **`INVARIANT_COUNT` becomes 17**, with 16 and 17 implemented from `13` §2.4 and invariant 4 carrying its amendment |
| 13 | PLYR-9 | Reward grant and the difficulty chain | `src/player/reward.js` | PLYR-5, **AI-10**, ITEM-7 ✅ | **13 §12 L5 (L1797) and L6 (L1798)**, **§2.5 (L503–519)**, **§3.5 (L605–632)**, §3.3's unlock table (L579–583) | every skill's **effective** level rises by exactly 1 on the **`quest`** stat layer and **no allocated level changes**; a second turn-in returns `false` and emits nothing (`questSkillPointsGranted ∈ {0,1}`, invariant 17); a full inventory produces `reward.held` and the item survives a reload; `items.grantUnique` delivers one of the three at `ilvl 15`, identified; killing Molgrim on Instruction unlocks **exactly** `trial`, on Trial **exactly** `renunciation`, and `setDifficulty('renunciation')` before the Trial kill returns `false` |
| 14 | UI-12 | Stash, vendor, quest log, dialogue | `src/ui/panels.js`, `src/ui/index.js` (**granted — wiring and `static deps` only**), `src/dev/shots.js` (**granted, one shot**) | UI-14, UI-6 ✅, WRLD-12 | **09 §15 U12 (L3087)**, §3.3 (L454–487), **§3.5's four wireframes (L689–740)**, §4.8 (L1060–1078), §6.4–§6.6 (L1557–1607), §13.1 (L2465–2502); **13 §7 (L897–1055)** | a full town loop — stash 4, sell 3, buy a potion stack, repair all, take a quest step — leaves gold and containers consistent with a **hand-computed ledger you write yourself**; five consecutive greetings per NPC differ and every NPC answers in all five quest states; the quest tracker rebuilds **only** on `quest:update`; DOM stays inside **105 / 108 / 12** for stash / vendor / tracker and the page never exceeds **700** nodes. **Blesses `vendor_open`** (D-110) |
| 15 | UI-13 | Screens: menu, creation, pause, death, reward | `src/ui/screens.js`, `src/ui/index.js` (**serialised against UI-12**) | UI-10 ✅, PLYR-7, UI-14 | **09 §15 U13 (L3088)**, **§3.5 (L505–564, L741–786)**, §11.2 (L2206–2246); **13 §9.9 (L1281–1299)**; 02 §14 (L1305) | `setScreen` covers **all six**, `reward_choice` included (D-105); create → play → die → respawn → quit → continue round-trips through `save` with **no data loss**; every option row writes through `save.saveSettings()` and survives a reload; the death screen's button is dimmed for **3.0 s on the raw clock**; the creation preview renders into `ctx.uiScene` and nothing else joins it; **no CSS transitions** — everything integrates `dt` in `lateUpdate` |
| 16 | SAVE-3 | Migration framework | `src/save/migrate.js` (D-106) | SAVE-2 | **01 §10.4 (L1644–1682)** | migrations are pure `vN_to_vN1(obj) → obj` functions in **one file**, importing no subsystem, touching no clock, no RNG and no `three`; `save.load()` applies them in ascending order and each intermediate passes §10.3 **for its own version**; a `SCHEMA_VERSION` bump **without a fixture fails the build**; `SCHEMA_VERSION` stays **1** in M6 (D-106) and the framework is proved by a synthetic v0 fixture, not by a real bump |
| 17 | TEST-10 | `tools/save-fuzz.mjs` | `tools/save-fuzz.mjs` (**lead-owned — granted explicitly**), `tests/fixtures/saves/**` | SAVE-3, PLYR-9 | **12 §5.4 (L390–406)**, §5.1 (L317–342), §6 (L445–476); 01 §10 | **5 000** characters across every legal combination round-trip to **deep equality after `rebuildCache`**; every committed fixture of every schema version loads and passes **all 17** invariants, and **a version with no fixture fails the run**; **8 000 mutants** (truncate, bit-flip, key-delete, and `NaN`/`Infinity`/`-1`/`1e308` into a numeric field) are **quarantined, never loaded, never crash the boot** — a mutant that loads and produces an invalid character is reported **separately** from one that crashes. Follows the **shipped** CLI (D-48): `=`-form flags, `--json` as a boolean switch, exit 0/1/2, a `checks[]` array, `NOTE` never changing the exit code, a check that cannot run reporting `skip` loudly |
| 18 | TEST-11 | `tools/playtest.mjs` | `tools/playtest.mjs` (**lead-owned — granted explicitly**) | AI-10, AI-11, PLYR-9, UI-13, TEST-10 | **12 §5.6 (L421–441)**, §8 (L507–539); **13 §12 L12 (L1803)** | a **scripted input sequence — not a bot** — drives a **real browser build** through create → four Instruction descents → Molgrim → reward → Trial unlocked, on **three seeds**, with `12.B01`–`12.B08` asserted **per seed**; `12.B07`'s two runs at one seed produce identical end-state hashes; **`13.P04` green** — level **13 ± 1** at the boss on every seed. Any assertion that cannot be measured in this harness reports **`skip`, loudly, naming M9** (D-112) — `baseline.mjs` and `profile.mjs` are not funded here |

### 3.3 Order notes you own and should not silently change

- **`PLYR-11` is first and alone**, and it is the only ticket in six milestones
  whose *file* is not known when it is scheduled. You measure first — your own
  probe, through a real `boot()` — then grant exactly one file. A subagent handed
  three candidate files will edit all three. If the measurement says the fix
  spans two subsystems, that is a finding for the owner, not a licence to widen
  the grant.
- **`WRLD-13` is second**, because every later world ticket and the whole
  `playtest` campaign walks through the zone O-107 fragments. Fixing it after
  `TEST-11` is written means re-running the slowest harness in the project.
- **`UI-14` is third and it is the critical path.** `13` §12 says so in as many
  words: "L0 and L1 are the critical path: nothing else in this document can be
  tested without the dictionary and the tables." UI-12 renders panels whose every
  label — all of `stash.*`, `vendor.*`, `container.*`, `quests.*`, `banner.*` —
  is currently missing from `i18n.js`. Scheduling UI-14 after UI-12 means UI-12
  invents keys and UI-14 renames them.
- **`PLYR-6` is fourth**, for the same reason on the other axis: `OPENING_RAMP`,
  `CLASS_START_KIT` and `QUEST_XP` are consumed by PLYR-5, PLYR-7 and PLYR-8, and
  M4's D-38 already recorded what happens when a table is duplicated instead of
  imported.
- **`WRLD-11` before `WRLD-12`, and both before `PLYR-5`.** Kaira is an
  `Interactable` before she is a quest trigger; a quest machine written against a
  town that does not exist mocks the thing it exists to consume.
- **`AI-10` early, not late.** It is the largest single ticket in the milestone
  (540 lines of spec, seven behaviours, three phases, six draws with a fixed RNG
  order), it gates `PLYR-9`, `AI-11` and `TEST-11`, and it is the one place where
  three rounds are genuinely likely. Start it as soon as a lane is free.
- **`PLYR-9` waits for `AI-10`.** The backlog gives it deps `PLYR-5, ITEM-7` and
  is wrong: `flags.slainOn[tier]` is written by quest step 5 on `actor:death`
  with the boss flag, so the difficulty chain cannot be verified before a boss
  exists to kill.
- **`SAVE-2` waits for `PLYR-5`**, because invariants 16 and 17 validate quest
  fields that PLYR-5 defines. Writing them first produces two definitions of the
  quest save shape.
- **`TEST-11` last, and after everything.** It is the instrument that plays the
  whole game; it cannot be written against nine tenths of one. It is also the
  slowest thing you will run — do not discover that at 3 a.m. of the gate.
- **`AI-13`, if it exists, goes after `AI-11`** and never in parallel with it;
  both live inside the same crowd/tier neighbourhood.

### 3.4 Parallelism — the permission and its conditions

Three lanes at most. The natural shape is **world → player/quest**, **ai**, and
**ui/save** — but the lanes braid: PLYR-5 needs WRLD-12, SAVE-2 needs PLYR-5,
UI-12 needs UI-14 *and* WRLD-12. Before you launch two subagents at once, all six
must hold:

1. **Disjoint owned files.** Compare the Files columns literally, not by prefix.
   The backlog's Files columns are known to be incomplete — ask each agent to
   declare any additional file it needs *before* it writes, and treat the
   declaration as the real disjointness check.
2. **Only one agent may hold `src/ui/index.js` at a time.** UI-12 and UI-13 both
   need wiring there, and `src/ui/i18n.js` is UI-14's for the whole ticket. If a
   later UI ticket needs a key, it reports the key and **you** write it.
3. **Only one agent may hold `src/dev/shots.js` at a time** — WRLD-11, AI-10 and
   UI-12 all register shots. Serialise, or you will merge four conflicting
   registrations by hand. M5 lost time to exactly this.
4. **Only one agent may hold `tools/balance.mjs` at a time** — PLYR-6 adds
   `--progression`, AI-10 adds `--boss`. Two flags, one file, and the harness is
   3 000 lines.
5. **Only one agent may hold `docs/spec/02-api-contracts.md` at a time.** M6 adds
   a great deal of surface: `save` alone brings `hasSlot`, `load`, `save`,
   `deleteSlot`, `loadStash`, `saveStash`, `settings`, `saveSettings`, `migrate`,
   `quarantine`, `setAutosave`, `requestAutosave`, `exportSlot`, `importSlot`,
   `estimateBytes`; `world` adds `setExitSealed`, `interactableAt`, `npcs`,
   `openChest`, `isTown`; `player` adds `questState`, `questFlag`,
   `advanceQuest`, `setDifficulty`, `respawn`, `createCharacter`; `ai` adds
   `spawnBoss`, `bossPhase`, `bossPhaseProgress`, `bossActor`; `ui` adds
   `openStash`, `openVendor`, `openDialogue`, `closeAll`, `isModalOpen`,
   `dialogueLine`, `worldLine`, `adj`, `toggleQuestLog`, `captureBinding`.
   Have the second agent report the row and write it yourself.
6. **Only one agent may hold `src/main.js` at a time.** M6 registers **no** new
   subsystem — `save`, `world`, `player`, `ai` and `ui` all exist. If an agent
   asks for a `registry.add`, it has misunderstood its ticket; O-12's two-line
   permission is **not** granted to anybody in M6, and **O-98** is the reason to
   care: registering a subsystem shifts the RNG stream of every subsystem after
   it, which would move every layout hash in the project.

**And verify serially.** Two agents may be *writing* at once; you run `npm test`
against one landed change at a time. A green suite containing two unverified
tickets tells you nothing about either. M1 measured what concurrency does to the
perf stage — the same test failed ~1 run in 9 idle and 2 in 4 with one subagent
running alongside — and M6 makes it worse still, because `playtest.mjs` launches
a real browser.

### 3.5 Spec slices

Verify each heading with `grep -n` before slicing — line numbers drift, headings
are authoritative. Remember: for `06 §13.n` and `07 §12.n` you want the **row**,
and then the real section it summarises.

```bash
# 13-progression-lore.md — the milestone's own document (1931 lines)
#   §1 progression L47-376 (1.2 OPENING_RAMP L151-198 — literal at L169-177,
#      1.3 quest XP L199-221, 1.4 INSTRUCTION TIER L222-259, 1.5 trial/renunciation
#      L261-292, 1.7 pacing + level-cap note L329-372)
#   §2 THE QUEST SYSTEM L378-519 (2.2 data model L386-448 — six trigger kinds L424-431,
#      five states L436-448; 2.3 runtime rules L450-467 — monotonicity L452, grantXp L463;
#      2.4 save representation L469-501 — INVARIANTS 16 AND 17 AT L498-499;
#      2.5 where "+1 to all skills" lives L503-519)
#   §3 the campaign L521-649 (3.2 THE SEVEN STEPS L531-551 — authoritative, D-101;
#      3.3 GATING L553-588 — gate table L557-560, difficulty unlocks L579-583;
#      3.4 tracker L590-603; 3.5 REWARD L605-632; 3.6 walkthrough L634-649)
#   §4 characters L651-760 (4.3 STARTING KITS L685-741 — table at L691-699;
#      4.4 name pattern L743-753)
#   §7 NPC DIALOGUE L897-1055 (7.1 selection rules L899-921; Veren L922, Isa L955,
#      Keeper L984, Kaira L1013)
#   §8 Molgrim's voice L1056-1108 (8.2 triggers L1064-1082, 8.3 the 18 lines L1084)
#   §9 the dictionary L1109-1432 (9.1 DO-NOT-REDEFINE list L1116-1146, 9.9 reward
#      screen L1281-1299, 9.11 dialogue panel L1314-1327, 9.17 COUNT L1390-1432)
#   §10 naming L1433-1736 (10.4 ui.adj AND THE 2688x4 ASSERTION L1502-1582)
#   §12 IMPLEMENTATION ORDER L1785-1811 (rows L0-L12, not subsections)
awk '/^## 12\. Implementation order/,/^## 13\./' docs/spec/13-progression-lore.md

# 06-monsters-ai.md — the boss half (3313 lines)
#   §7 MOLGRIM L1646-2186
#     (7.1 the actor + per-tier stat block L1648-1679, 7.2 no basic attack L1681,
#      7.3 PATTERN DAMAGE L1696-1718, 7.4 PHASE STRUCTURE + TRANSITION TIMELINE L1720-1741,
#      7.5 phase I L1743-1786 (sweep L1747, summon L1768),
#      7.6 phase II L1788-1875 (ember_rings L1790 + gap draw L1824-1831, dash L1847),
#      7.7 phase III L1877-1963 (meteor L1881, blink L1901, syllable_burn L1934),
#      7.8 SAFE WINDOWS L1965-2026, 7.9 UPTIME/ENRAGE/RESET L2028-2113,
#      7.10 TTK L2115-2185)
#   §11 DIFFICULTY TIERS L2713-2811 (11.1 zone levels L2727, 11.2 affix frequency L2735,
#      11.3 PER-TIER BEHAVIOURS L2752-2763 — AI-11's actual deliverable,
#      11.4 immunities L2772-2789, 11.5 what does not change L2799)
#   §12.2 MB1-MB20 L2830-2854   §13 rows 10-11 L2930-2931
#   §14.3 BOSS RNG DRAW ORDER L2980-2989   §15 D-3/D-4/D-5/D-9/D-10/D-13
#   §16 A6 ai.bossPhaseProgress L3248
awk '/^## 13\. Implementation order/,/^## 14\./' docs/spec/06-monsters-ai.md

# 07-world-gen.md — the town (2683 lines)
#   §2 LAST BASTION L285-592 (2.1 descriptor L287-315, 2.2 THE SEVEN ARRAYS L317-454
#      — NPCS L381, INTERACTABLES L393, ENTRIES L403, LIGHTS L412, PROPS L422,
#      format rules L430-454; 2.3 THE MAP L456-521; 2.4 regions L523; 2.5 occlusion L534;
#      2.6 walkable/connectivity + THE FIXTURE L560-592)
#   §5.3 G1-G6 FIGHT SPACE L1313-1414 (G1 sweep L1318, G2 summon ring L1330,
#      G3 fire rings L1340, G4 teleport anchors L1370, G5 meteor L1388, G6 cover L1400)
#   §6.5 build cost table L1578-1596   §8.4 boss spawn point   §9.3 Interactable L2179-2202
#   §10.4 what is preserved / town never disposed L2401-2404   §12 row 3 L2560
# 09-ui.md: §3.3 panel geometry L454-487, §3.4 layers L489-502,
#   §3.5 WIREFRAMES L503-786 (menu L505, creation L533, stash L689, vendor L704,
#   quest log L720, pause/options L741, death L762), §4.8 quest tracker L1060-1078,
#   §6.4-6.6 modifier moves/sorting/container matrix L1557-1607,
#   §11.2 keybinds L2206-2246, §13.1 DOM BUDGETS L2465-2502,
#   §14.1 i18n mechanism L2591-2617, §14.2 data-owned strings L2618-2645,
#   §14.3 THE 344 KEYS L2646-3066, §15 U12/U13 L3087-3088
# 01-data-model.md: §10 SAVE L1504-1682 (10.1 keys L1508, 10.2 shapes L1517-1615,
#   10.3 INVARIANTS 1-15 L1616-1642, 10.4 MIGRATION POLICY L1644-1682)
# 03-combat-math.md: §10.2 difficulty tiers L1009-1032, §10.3 zone levels L1036-1040,
#   §10.6 DEATH PENALTY L1140-1152, §9.1/§9.3/§9.5 for the boss's own numbers
# 11-flows.md: §6.7 DEATH L1143-1164, §7 death and loot L1166-1304,
#   §8 level up L1306-1392, retention table L1476-1489, boot stage 5 L264
# 12-testing.md: §5.1 CLI L317-342, §5.4 SAVE-FUZZ L390-406, §5.6 PLAYTEST L421-441,
#   §6 fixtures L445-476, §7 determinism L478-506, §8 perf gates L507-539,
#   §9.1 THE SHOT SET L546-565, §11 M6 GATE ROW L643
# 02-api-contracts.md: world §5 L363-456 (setExitSealed L415, interactableAt L420,
#   npcs L421), ai §12 (bossPhaseProgress L1110, boss:phase L1132/1135/1148),
#   items grantUnique L987 / cursorItem L1020, player setDifficulty L1200,
#   ui L1295-1327 (setScreen L1305, adj L1311, dialogueLine L1312, worldLine L1313)
```

## 4. Standing constraints carried into M6

Each was paid for in M0–M5 and is recorded in `PROGRESS.md`. Put the relevant
ones **into the brief of the ticket they bind**, by name.

### 4.1 Performance and correctness rules found by measurement (all tickets)

- `Math.hypot` allocates — 5.73 B/call vs 0.34 B for `Math.sqrt(x*x + y*y)`.
  Banned in anything marked `Alloc = no`. M6's distance work is the boss's anchor
  selection, the interactable proximity test and the meteor Poisson pass.
- `Map` leaks on never-repeating keys (~456 B/call), and **`Map.prototype.clear()`
  allocates unconditionally, even on an empty map.** The house idiom is the
  **generation stamp**: a flat typed array keyed by slot index holding
  `generation × 2³² + value`, where a mismatch means "absent". Invented for
  `actor.cooldowns` (SKIL-2), reused for rage credit (D-57) and buff slots
  (SKIL-13). **Do not invent a fifth variant** — the boss's per-pattern cooldowns
  and the quest's flag set are both exactly this shape.
- `array.length = 0` tears the backing store; the next write reallocates.
- Template strings in a hot path allocate. Quest flags, dialogue keys and
  interactable ids are all string-shaped — resolve them to an integer index once
  in `init()` and dispatch on that.
- **A time-based criterion hides an abort.** M1's most expensive lesson: NAV-2
  met "≤ 1 ms" by refusing to work, and O-144 found the same shape again in M5.
  Wherever a criterion measures time, pair it with a criterion on **work actually
  done**. In M6 this binds **TEST-11** hardest: `12.B01` ("completes inside 12
  minutes of simulated time") is trivially met by a script that gives up, which
  is exactly why `12.B06` demands the quest reach `complete` in the same breath.
  Assert both, always together.
- **O-43/O-23: allocation probes need N ≥ 1 000 000.** On correct code the mean
  decays 80.45 → 17.88 → 0.391 → 0.325 B/call as N goes 10k → 100k → 1M → 4M. Fix
  by lengthening the warm-up, never by loosening the threshold; distinguish a
  real leak by watching **total** bytes.
- **O-135 is live and unfixed for the rest of the tree**: an allocation probe
  that divides the cost of a *round* by the number of calls hides the real figure.
  One probe was corrected; **every other `Alloc: no` probe still counts the old
  way**. If a new M6 probe reads suspiciously clean, check how it divides before
  you believe it.
- **O-137's ruling defines `Alloc: no`**: at most one boxed return value and
  nothing beyond it — 16 bytes, pinned exactly in the test, not "about zero".
  Any new `Alloc = no` contract method in M6 inherits that definition.
- **O-85 / O-93 / O-117: three probes flake, and the recorded conclusion is that
  the thresholds sit too close to the measurement.** Never call a red allocation
  probe a regression until you have re-run it alone. Fix by isolation or by
  moving it into a `*.perf.test.js` file — never by retry, never by loosening.
- **The class of defect this project keeps producing, five times in M5's last
  session alone: a check that weakens the criterion by exactly enough to pass.**
  Its general form is written up as *"the instrument measured itself, not the
  subject"* (O-106, O-119, O-129, O-141, O-147). Read it before you accept any
  harness output in M6 — three new harnesses land in this milestone.

### 4.2 The rulings — settled, binding, brief from these

Twenty divergences, **D-94…D-113**, all orchestrator rulings settled by this
prompt. Journal them as D-entries on first contact so M7 does not re-litigate
them. **Verify each against the files before you use it — do not re-open it.**

**⚠ Naming collisions, read this first.** `05-skills.md` numbers its own balance
decisions `D-05-1…3`, `09-ui.md` has its own `D-15`, and `06-monsters-ai.md` §15
has `D-1…D-13` — none of them is `PROGRESS`'s `D-n`. Cite as `06 §15 D-5` versus
`PROGRESS D-95`. `07-world-gen.md` reuses `G1`–`G6` (Altar fight space) and
`G1`–`G9` (prop groups) inside one document, and **M6 is the milestone that
finally uses the first set** — every `G` in an AI-10 brief is `07` §5.3's.

---

**1. M5's residue is your phase 0. M5 does not close by declaration. [D-94]**

Four gate items are red — ④ `mapgen`, ⑥ `--monsters`, ⑧ the corridor, ⑪ the
combat freeze — and §1.1 states each one's disposition: two become tickets
(`PLYR-11`, `WRLD-13`), two go to the owner. The reason this is a ruling rather
than a chore is that the previous milestone's own prompt said it plainly: *"Red
gate = milestone not closed. There is no 'we will fix it in M6'."* M6 is the
milestone that has to honour that sentence, and the honest way to honour it is
not to declare M5 green — it is to close what is closeable, name what is not, and
get an owner acknowledgement for the remainder.

Item ⑪ is not optional under any reading. The M6 gate's first line is *"the game
is completable"*. A player who freezes 36 m into a fight cannot complete
anything, and no amount of boss code changes that.

Write the M5 gate table into `PROGRESS.md` as part of this phase — twelve rows,
honest verdicts, and the four red ones carrying their O-numbers. There has never
been one, and its absence is why this prompt had to reconstruct the results from
prose.

---

**2. The combat freeze is micro-ticket `PLYR-11`, and you measure first. [D-95]**

`O-145`'s measurement is unambiguous about the symptom and explicitly silent
about the cause: navigation is healthy at the stall point, orders are accepted,
and the actor does not move. The previous orchestrator wrote *«Не назначаю без
замера»* — I am not overriding that, I am funding it. **Your first act on this
ticket is your own probe**, through a real `boot()`, that answers one question:
does the actor's position stop changing while `player` still wants it to move
(then it is `src/player/move.js` or `src/actors/motion.js`), or does it stop
because bodies are pressing it (then it is `src/physics/separate.js` or
`src/ai/crowd.js`, and **O-105** — an attacking monster with no steering
avoidance, bodies pressed to 0.084 m — is the standing candidate)?

Grant **one** file on the answer. Precedent and shape: D-42/ACTR-20,
D-49/ACTR-21, D-61/ACTR-24 — a named micro-scope inside a file owned by closed
milestones, with the same restraint. No new behaviour beyond the fix; no
signature drift; each touched method's `02` row re-checked for its
`Fixed`/`Alloc` columns.

Two process notes, both from O-145's own write-up. First, **two drafts of that
probe were wrong before the third was right** — one re-issued the order every
frame, which cancelled the in-flight solve after O-144 made solves span up to
three steps, and read 0 casts that meant nothing. Second, **the probe was never
committed**, because a red test breaks gate item ②. Your ticket's deliverable is
that probe, committed and green.

---

**3. The Wastes entry region is micro-ticket `WRLD-13`. [D-96]**

`O-107` is one defect with three visible faces: `I1` fails on the Wastes because
the entry region is fragmented; `I2` sits at 566/600 because 41 chests land
outside it and the 2.0 m snap cannot reach them; and the zone descriptor is
internally inconsistent about where the entry is. `O-140` already saved 518 of
559 chests by snapping — the remaining 41 are not a snapper problem and no
further tool-side patch will move them. `O-138` is separate and equally real:
`I1` on Bonereach was first read as a cell-boundary artefact, that reading was
**withdrawn**, and what remains is a wall and a column — *«его нельзя закрыть
правкой инструмента»*.

Scope: `src/world/gen/wastes.js`, `src/world/gen/bonereach.js`, and the Wastes
row of `src/world/data/zones.js` — that last one granted narrowly, because
`zones.js` also carries six recorded balance divergences that are **forbidden to
touch before M7** (O-139). Say so in the brief.

Out of scope, and going to the owner instead: **`I8` on the Wastes** (D-83 ruled
it structurally unsatisfiable indoors; D-90 made the Altar's a counting `NOTE`;
the Wastes stayed `FAIL`) and **`I9`**, which cannot be judged by anybody until
`src/sky/` exists in M8.

---

**4. The town is `07 §2`, and the paths are the spec's. This narrows D-65. [D-97]**

`BACKLOG.md:244` and `:245` both cite `07 §3` for the town. `07` §3 is *the
Ashen Wastes — the Ridgewalk generator* (L594). The town is **§2, L285–592**. An
agent following the citation literally builds a generator for a hand-authored
zone.

The paths need a ruling in the opposite direction from M5's. The backlog says
`src/world/town.js` and `src/world/data/town.js`; the spec says
**`src/world/data/last_bastion.js`** (§2.2, three times) and
**`src/world/build/town.js`** (§12 row 3). D-65 said the backlog wins where they
disagree — and D-65 was decided when `src/world/` held four files and no
convention. **It now holds one**: generators in `gen/`, `three`-side construction
in `build/`, data in `data/`, and every tool keyed on the zone id
(`mapgen --zone last_bastion`, the fixture `last_bastion.json`). A file called
`src/world/town.js` would be the only zone in the project that lives outside it.
**Ruling: the spec's paths win here**, and D-65 is narrowed to "where neither the
tree nor a tool has already answered the question".

One consequence to state in the brief: `build/town.js` may import `three` under
the pointed exception recorded as **D-78**; `data/last_bastion.js` may not, and
it is auto-discovered as a headless lint root the moment it exists.

---

**5. The sealed gate is Bonereach's; the chest is the stash. [D-98]**

`BACKLOG.md:245` titles WRLD-12 *"NPCs, chest, stash, gate sealing"* and points
at the town. Three corrections, all cheap and all load-bearing:

- **The gate that seals is Bonereach's `stair` exit** to the Altar
  (`13`:555–556, `13`:568–570: `world.setExitSealed('bonereach','gate',sealed)`).
  Last Bastion's own `gate_exit` (`07`:395) is a plain always-open trigger to the
  Wastes and no document ever seals it. Sealing the wrong gate produces a town
  the player cannot leave.
- **There is no chest in Last Bastion.** `chestCount: { min: 0, max: 0 }`
  (`07`:307). The only chest-shaped object is `{ id:'stash_chest', kind:'stash' }`
  (`07`:394). Say "stash chest" in the brief and the ticket will not go looking
  for loot tables.
- **`NpcDescriptor` is referenced and never defined.** `02`:421 returns
  `NpcDescriptor[]`, `09`:2635 keys i18n off `npc.<npcId>`, and no document gives
  the record a shape. **Pin it to `07` §2.2's `NPCS` literal** —
  `{ id, archetypeId, x, z, facing, radius, role, services }` — and add the row
  to `02` yourself. An invented shape here propagates into UI-12's dialogue
  panel and PLYR-5's `talk` trigger.

---

**6. 310 footprints and 0.54 ms are estimates, not measurements. [D-99]**

`BACKLOG.md:244` reads them as asserts. `07`:1585–1590 says in as many words that
the whole §6.5 table is *"estimates from the cost model above, not
measurements"*, and that the binding check is **p95 against the budget column** —
**2.0 ms** for the town — reported by `mapgen --timing`. Worse, the number **310
appears nowhere in `07` §2**: it is derivable from nothing the section states,
because §2.2 says each structure becomes *"1..N Footprints"* without fixing N.

WRLD-11's real, checkable gates are the four in §12 row 3: the ASCII map
reproduces **character for character**, walkable cells equal the fixture **± 0**,
`regionCount === 1`, and `I8` passes. Add `PROPS[i].n` summing to
`POINTS.length / 5` as a load-time failure (format rule 5) — that one is the
cheapest real check in the ticket.

And do **not** apply the "prop count within 5 % of `propBudget`" rule here: the
town's `propBudget` is 520 against 282 authored props, and that rule is the
Wastes' (§12 row 6). Applying it to the town fails by 46 % on correct data.

---

**7. `town_spawn` does not exist. [D-100]**

`11-flows.md` requests `world.requestZone('last_bastion','town_spawn')` at
`:215`, `:347`, `:1156` and `:1720` — the boot path and the respawn path. Last
Bastion's `entryTags` are `['town_start','from_wastes','town_portal_return']`
(`07`:305), and `src/world/data/zones.js:49` copies that verbatim. **The tag is
`town_start`.** PLYR-8 uses it; record the conflict against `11-flows.md` as a
spec finding with no owner in M6.

---

**8. Doc 13 contradicts itself about step numbers. §3.2 wins. [D-101]**

Five places disagree, and PLYR-5 will meet all of them:

- `13`:243–246 calls entering the Wastes/Bonereach/Altar steps **1/2/3**; §3.2
  makes them **2/3/4**.
- `13`:352 says the Gate opens at *"quest step ≥ 2"*; §3.3 says `step < 3` sealed,
  `step >= 3` open, and L4's acceptance says step 3.
- `13`:172's `OPENING_RAMP.activeWhile: q.step <= 1` is glossed at `:186` as
  "the moment the player first reaches Bonereach the quest is at step 2" —
  reaching Bonereach is step **3**, so the predicate actually switches the ramp
  off on the second Wastes entry.
- `13`:475 comments `step: 3, // int 0..6`; §3.2 declares `steps.length === 7`
  and `step === 7` terminal, and invariant 16 allows `0..7`.
- `13`:411–416's sample `QuestStep` uses `index: 2` for what §3.2 calls step 3.

**§3.2 (L531–551) is authoritative**, on the strength of being the only complete
enumeration and of matching invariant 16. Seven steps; the gate opens at
`step >= 3`; `step === 7` is terminal. Put that sentence in the brief and paste
the §3.2 table verbatim.

---

**9. Six of `13 §12`'s thirteen rows have no backlog owner. [D-102]**

M6's tickets cite L0, L1, L2, L5, L6 and L7. The rest are real work with real
acceptance checks and no ticket. Assigned here:

| Row | What it is | Owner |
|---|---|---|
| **L3** | `flags.slainOn`, `flags.rewardChoice`, **invariants 16 and 17**, the amended invariant 4 | **SAVE-2**, as a second named micro-scope in `src/save/schema.js` |
| **L4** | `player` calls `world.setExitSealed` on `quest:update` and `zone:ready`; `prompt.gateSealed` | **PLYR-5** (WRLD-12 owns only the `world` half) |
| **L8** | the five dialogue line families, the non-repeating rotation, the quest-stage override, the idle-bark timer | **UI-12** (behaviour) + **UI-14** (the 98 keys) |
| **L9** | Molgrim's eighteen lines on their triggers, rate-limited, world-anchored | **AI-10** (fires `ui.worldLine`) + **UI-14** (the 18 keys) |
| **L10** | `ui.adj` integration, the 64-entry recent ring, the 2 688 × 4 agreement assertion | **UI-14** (the pools themselves shipped with ITEM-8 — verify, do not rebuild) |
| **L11** | the `experience` clamp at 317 106, zero death penalty at level 30 | **PLYR-8**, as a named micro-scope in `src/player/progress.js` |

L11's UI half — `hud.maxLevel` in place of the XP fraction, `banner.maxLevel`
once — lives in `src/ui/hud.js`, which no M6 ticket owns. UI-14 ships the keys;
record the rendering as **carried**, with a recommendation, rather than smuggling
`hud.js` into a UI-12 grant.

---

**10. `13.P01`–`13.P04` do not exist. Defined here. [D-103]**

The M6 gate line (`12`:643) requires *"`13.P01`–`13.P04` pass"*. Doc 13 owns the
reserved letter `P` (`12`:149) and **numbers nothing with it** — grepping for
`13.P` returns zero hits. This is D-68's shape exactly: a gate written against
assertions the owning document never wrote.

Defined, from doc 13's own provable claims, and owned:

| id | Assertion | Owner | Bound |
|---|---|---|---|
| **13.P01** | `XP_TABLE`/`XP_TOTAL` reproduce §1.4's Instruction table and §1.5's Trial and Renunciation tables **to the unit**, and the three boss levels are **13 / 24 / 30** | PLYR-6 | exact |
| **13.P02** | `OPENING_RAMP` reproduces §1.4's first-descent figure (1 559 ramped), and quest XP is **600 / 3 400 / 4 000 / 2 000 = 8 000**, which is **24.6 %** of 32 493 | PLYR-6 | exact / ±0.1 pp |
| **13.P03** | the death penalty of `03` §10.6: **238** at clvl 10, **1 383** at clvl 29, **0** below clvl 5, **0** at level 30, and `experience` never falls below `XP_TOTAL(clvl)` | PLYR-8 | exact |
| **13.P04** | a `--campaign` run reaches level **13 ± 1** at the boss on **every** one of three seeds | TEST-11 | ±1 level |

They are run by `node tools/balance.mjs --progression` (P01–P03) and
`node tools/playtest.mjs --campaign` (P04). **`--progression` is a second named
micro-scope inside PLYR-6** — precedent D-70's `--monsters` inside TEST-9 and
D-38's `XP_TOTAL` inside PLYR-4. `--builds` and `--sweep` stay M7's and keep
exiting `2`.

If you find that doc 13 *does* define `P` assertions somewhere this prompt
missed, they win and mine are withdrawn — say so in your first report.

---

**11. UI-14 is not "473 keys", and it is the critical path. [D-104]**

Three numbers have to be reconciled before this ticket is briefed.
`13` §12 L0 asks for **473** new keys. `13`:1428–1430 states the intended
shipped total: **817 English keys and 948 Russian entries**, combining doc 13's
473 with `09` §14.3's 344. The tree carries **302 EN and 302 RU**.

So: roughly **100 rows of `09` §14.3 were never shipped** — including *every*
`stash.*`, `vendor.*`, `container.*`, `quests.*`, `banner.*`, `toast.*`, `prompt`
and `skills.*` family — and **58 shipped keys are renames** of §14.3 rows
(`stat.skillBonusAll` for `stat.skillsAll`, `stat.damageRange` for
`stat.minDamagePair`, and so on). A literal "add the missing hundred" produces
two keys for one meaning. UI-14's real scope is **473 + the ~100 unshipped +
131 RU gendered variants, with the 58 reconciled rather than duplicated**, plus
`ui.adj` and the 2 688 × 4 agreement assertion.

Two consequences. **UI-14 lands before UI-12**, because UI-12 cannot render a
stash panel whose every label is missing; if it goes second, it invents keys and
UI-14 renames them a day later. And **if the rename reconciliation proves larger
than the dictionary work** — it touches `tooltip.js`, `sheet.js` and `hud.js`,
none of which UI-14 owns — **split it out as `UI-16` and say so**, rather than
letting one ticket quietly become two. Precedent: D-70's contingency, which was
correctly *not* exercised in M5.

`13` §9.1 (L1116–1146) lists the twenty keys that already exist in `09` §14.3 and
**must not be redefined**. That list goes into the brief verbatim.

---

**12. `setScreen` has six screens, and UI-13 renders the sixth. [D-105]**

`09`:3113 lists five and is stale. `02`:1305 lists six, with `reward_choice`
described as *"a non-dismissible modal over the game, not a panel"*; `13`:1830 is
the request that added it; and `src/ui/index.js:69`'s `VALID_SCREENS` already
carries all six. `02` is canonical and the code agrees.

The division of labour needs saying because the ticket boundary hides it:
**UI-13 renders `reward_choice`** (its content is `13` §9.9, L1281–1299), and
**PLYR-9 owns the grant behind it** — `items.grantUnique`, `skillBonuses.all`,
`questSkillPointsGranted`. A reward screen that grants, or a grant that renders,
is the wrong ticket doing the work, and this is the single irreversible
transaction in the game (`13`:1808).

---

**13. Save layout: one migration file, fixtures under `tests/`, no version bump. [D-106]**

Four sub-rulings, all small, all cheaper to make now than to discover:

- **Migrations live in `src/save/migrate.js`** — one file holding a table of pure
  `vN_to_vN1(obj) → obj` functions. `01`:1650 asks for a `src/save/migrations/`
  directory; the backlog says one file; `src/save/` is a full lint root, so a new
  subdirectory changes the root count for no benefit at one migration. The
  functions keep every property `01` §10.4 rule 2 demands: plain JSON in and out,
  no subsystem import, no clock, no RNG, no `three`.
- **Fixtures live under `tests/fixtures/saves/vN/`**, per `12` §6's tree
  (L449) — not `tools/fixtures/save/` (`01`:1660). `tests/fixtures/` already
  exists and the shot fixtures are there. Same ruling for WRLD-11's nav fixture:
  **`tests/fixtures/nav/last_bastion.json`**. One place for fixtures, and both
  `01` §10.4 rule 5 and `12` §6 rule 4 make them immutable once written, so
  choosing late costs the evidence they exist to preserve.
- **`SCHEMA_VERSION` stays `1` through M6.** Every field M6 adds — `flags.slainOn`,
  `flags.rewardChoice`, `questSkillPointsGranted`, `cursorItem` — is an optional
  field with a default, which `01` §10.4 rule 7 explicitly says is **not** a bump.
  SAVE-3's framework is therefore proved against a **synthetic v0 fixture**, not
  against a real bump: a migration framework that has never run a migration is
  the thing rule 4 exists to prevent.
- **`cursorItem` is such a field.** SAVE-2's acceptance ("a mid-drag autosave
  keeps `cursorItem`") has no home in any `01` §10.2 shape today. Add it to
  `CharacterSave` as `cursorItem: ItemInstance | null`, default `null`, and make
  invariant 8's uid-uniqueness sweep count it — an item in the cursor is an item.
  **`INVARIANT_COUNT` becomes 17** in the same ticket.

---

**14. The name pattern is the Cyrillic one. [D-107]**

`09`:557 mandates `[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9 '-]{0,15}` and says the
Cyrillic range is not optional; `13` §12 L7 requires a Cyrillic name to round-trip
through `localStorage`. `01`:1534 still documents the ASCII-only pattern. **The
Cyrillic pattern wins**; `01`:1534 is stale. Nothing validates the name today —
no invariant covers it — so this bites at PLYR-7, UI-13 and SAVE-2 rather than at
load, and it is the kind of thing that is discovered by a Russian-speaking
player, not by a test.

---

**15. AI-10's gates are MB5, MB5b and MB15 — and its numbers have traps. [D-108]**

`BACKLOG.md:251` gives AI-10 prose ("`boss:phase` at spawn and each transition;
all three phases dodgeable") and **no assertion at all**. `06` §13 row 10 names
**MB5**, **MB5b**, **MB15**, and `tools/balance.mjs`'s own skip table already
tags all three "M6". This is D-64's shape repeating: the backlog's assertion sets
are unreliable and the spec's implementation-order row is the real gate.

Six numeric traps to put in the brief, each of which silently produces a
plausible boss:

1. **Two `U` values exist and only one is MB15's.** `03` §9.5 declares
   0.95/0.82/0.85 → 0.8795; `06` §7.9 derives 0.866/0.880/0.863 → 0.8703, and
   `06` §15 D-10 records the resolution. **MB15 asserts §7.9's per-class rows**
   (Ravager 0.848/0.893/0.833) within ±0.05 absolute, and MB5's TTK must use the
   schedule-derived per-class `U` **and** the phase-III blind factor
   (0.9792/1.0000/0.9797). A flat 0.88 gives 76.1/63.9/86.0 and misses MB5's
   binding case.
2. **MB5's Runeblade has 0.51 s of margin** against the 90.0 s ceiling (89.49 s).
   The spec's own worked failure block is a Runeblade at 94.583 s. That is the
   canary; any drift in uptime accounting flips it red.
3. **Seven named behaviours, six of which draw.** §13 row 10 says "all six
   patterns"; §7 specifies `instructor_sweep`, `summon_ranker`, `ember_rings`,
   `instructor_dash`, `meteor_rain`, `blink` and `syllable_burn`. §14.3's draw
   table lists six because `syllable_burn` is an aura and draws nothing. Say
   "seven, six of which draw" or one gets dropped.
4. **Three gaps per ring, not one.** `07` §5.3 G3's prose says "one gap" and G3.3
   computes the crossing margin for a single-gap ring; `06` §7.6 fixes **3**, and
   `06`:2010–2013 reconciles them — three gaps at 120° is strictly easier at
   every radius, so G3.3 is a lower bound, not a spec. Likewise `03`'s "3 gaps of
   40°" and `07`'s "4.00 m constant linear gap" are the same statement (`06` §15
   D-4): **implement the linear invariant**, 40.9° at r = 5.73 m is a readout.
5. **`blink` is a cooldown with a gate, not a period** (`06` §15 D-9). Read as
   "every 4 s" it fires against a ranged player who is never within 6.0 m, phase
   III uptime collapses to 0.575, and MB15 fails. And the inner-ring (r = 8.0 m)
   preference is `06` §7.7's, not `07` G4's — it is what makes the melee chase
   3.44 m instead of 9.6 m, and the uptime table depends on it.
6. **The anchors already exist.** WRLD-8 shipped the 8 summon and 12 teleport
   anchors in `src/world/gen/altar.js` and measured 12 000/12 000 anchor checks.
   AI-10 **reads them from the arena**; a re-derived anchor set that looks right
   is precisely the fabrication D-38's incident records.

`balance.mjs --boss` is a **second named micro-scope inside AI-10**. If it
outgrows the harness it plugs into, **split it as `TEST-17`** — the next free
TEST id, since `TEST-12`…`TEST-16` belong to M7–M9 — and say so.

Two smaller things to record rather than solve: §7.8's worst margin is quoted as
**1.16×** in the table and **1.28×** twice in prose (the 1.28 is the Archer's
class-spread figure and has wandered); and §12.2 has **21** rows (MB1…MB20 plus
MB5b) while §13 row 12 requires "20/20 pass". AI-10 landing MB5b makes that count
question unavoidable — report it, do not renumber anything.

---

**16. AI-11 imports the offsets from `world`, and merges into the layer. [D-109]**

`BACKLOG.md:252` says `+0/+12/+22` is *"imported from `combat`, never
redeclared"*. **There is no such export in `combat`.** `03` §10.2 is the
documentary authority for the *values*; the only shipped copy in the tree is
`src/world/spawn.js:247`'s `DIFFICULTY_MLVL_OFFSET`, and `src/ai/rank.js:91`
says so at the call site. AI-11 imports from `src/world/spawn.js` — or you
relocate the constant deliberately and record it — but it does not redeclare a
fourth copy. `tools/balance.mjs:3094` already cross-checks two of them.

**The layer trap is flagged at its own call site and is the expensive one.**
`src/ai/index.js:686–688`: monster affix stats enter through the actor's
`'difficulty'` stat layer, and `setSourceLayer` **stores the object wholesale**.
An AI-11 that writes tier multipliers into that layer by assignment erases every
champion's affix stats the instant a tier lands, and every affected test still
passes because affixes and tiers are never asserted together. **Merge.**

Assertion set, from `06` §13 row 11: **MB2–MB5b, MB7, MB8 re-run at Trial and
Renunciation, MB11 at every tier**. The row says "MB2–MB8", which sweeps in
**MB6** — and MB6 is M7's gate, which `tools/balance.mjs:2883` already knows and
which is circular besides (MB6 needs the tier behaviours AI-11 is building).
**MB6 reports `skip`, loudly, naming M7.**

One dividend to collect: `mapgen`'s sweep is **1826 layouts, not 5 400**, and the
missing ×3 is difficulty tiers (`--difficulty=` exits `2` naming M6). AI-11 is
the ticket that makes the third dimension real. Granting `tools/mapgen.mjs
--difficulty=` as a **third named micro-scope** is how M5's gate item ④ finally
becomes measurable at its stated size — take it, and say in your report whether
the full 5 400 then runs inside its budget.

---

**17. Four shots, four owners, and none of them is in the backlog. [D-110]**

`12`:643 requires `town_overview`, `altar_arena` and `boss_phase_2` to enter the
baseline. `12` §9.1 assigns all three to M6. **No M6 backlog row mentions a shot
at all**, and none of the three exists in `src/dev/shots.js` — the identical hole
D-40 found in M4 and D-69 found in M5, now for the third time.

There is a fourth. **`vendor_open`** is labelled M3 in `12` §9.1, was formally
deferred to M6 by **D-22/O-60**, restated in M4's prompt, and **`BACKLOG.md`'s
UI-12 row never picked it up**. It has now fallen through the same crack twice.

Owners, on the UI-1/`ui_clean` precedent: **`town_overview` → WRLD-11**,
**`altar_arena` and `boss_phase_2` → AI-10**, **`vendor_open` → UI-12**. Each
registers, captures, **looks at the PNG**, and blesses with an honest
`description` saying what the frame contains and what it does not.

---

**18. `TEST-10` is `save-fuzz.mjs`. The id is free. [D-111]**

`ORCHESTRATOR_PROMPT_M5.md:712` says: *"If `--monsters` turns out to be larger
than the harness it plugs into — split it out as `TEST-10` and say so"*. **It did
not.** TEST-9 shipped `mapgen.mjs` and `balance.mjs --monsters` as one ticket in
one round with two named micro-scopes (`PROGRESS.md:473`), and no line anywhere
assigns the id to anything. `BACKLOG.md:258` and `PROGRESS.md:1453` both use
TEST-10 for `save-fuzz.mjs`.

This is a ruling only because a subagent grepping the M5 prompt for "TEST-10"
finds the `--monsters` sentence first and will believe it. Say it out loud in the
brief.

---

**19. TEST-11 owns one file, and says `skip` when it cannot measure. [D-112]**

`12` §14 schedules `playtest.mjs` in **step 8** — "M9's gate" — alongside
`baseline.mjs` and `profile.mjs`. `12` §11 demands it green at **M6**. Neither
`baseline.mjs` nor `profile.mjs` exists, and `12.B03` (no frame over 50 ms),
`12.B05` (zero shader compilations after the first frame) and `12.B08` (peak heap
growth < 40 MB, and within 8 MB of the pre-descent heap after a return to town)
all need instrumentation `capture.mjs` does not currently expose.

**Scope it explicitly or the ticket grows a profiler.** TEST-11 owns
`tools/playtest.mjs` and nothing else; it drives the real build through the same
Playwright path `capture.mjs` uses; `render.stats.programs` is the shipped way to
answer B05 and MATL-1's traverse is the precedent. Anything it genuinely cannot
measure in that harness reports **`skip`, loudly, naming M9** — O-58 exists
because an assertion was excluded from a list instead of fixed, and a silent
omission here reads as a green campaign.

Two more bindings: the M6 gate says **three seeds** while `12` §5.6 describes one
fixed seed — `13` §12 L12 reconciles them (`--campaign`, three seeds, level
13 ± 1 at the boss), so bind to the `--campaign` form and assert **B01–B08 per
seed**. And `12.B02` ("the character never dies — the script plays
conservatively") means the script is a **scripted input sequence, not a bot**;
an agent that writes a decision-making AI to satisfy it has written the wrong
thing.

---

**20. Nothing renders. Say so on every frame you bless. [D-113]**

**O-128 is open**: `actor.view.root` is only ever assigned `null`, so no actor
appears in the application. M5's `dense_combat` did not change when Bonereach
gained monsters, and the previous orchestrator recorded that this is *"граница
этапа, а не доказательство отсутствия визуальной регрессии"*. The backlog owner
is `ACTR-16…ACTR-19` / `MATL-3`, in M7 and M8.

For M6 this means `boss_phase_2` — "Molgrim mid-fire-ring, telegraph visible" —
**cannot show Molgrim**. Do not fake it, do not defer the shot, and do not treat
it as blocked: register it, capture it, look at it, and bless it with a
description that says exactly what it proves (the arena, the camera, whatever
`fx`-less telegraph state exists) and what it does not (any actor at all).
Precedent: M2's O-56, M3's D-22, M4's `skill_tree_ravager`, M5's `dense_combat` —
four milestones of honest partial frames, and they are good ones.

### 4.3 Per-ticket bindings

| Ticket | Must be told |
|---|---|
| PLYR-11 | You are being handed **one** file and a measurement that already exists; do not go looking for a second. The order is accepted and the path solves — the actor does not move. **O-105** is the standing candidate. Your deliverable is a **committed, green** test that reproduces the O-145 scenario through a real `boot()`; the previous session's probe was red and deliberately left uncommitted. Two of its drafts were wrong in ways worth knowing: re-issuing the order every frame cancels an in-flight solve (solves span up to 3 steps since O-144), and re-issuing on target drift never fires against a stationary target |
| WRLD-13 | O-107 is **one** cause with three faces; fix the cause, not the faces. `src/world/data/zones.js` is granted for the **Wastes descriptor row only** — the file also carries six recorded balance divergences that are **forbidden to touch before M7** (O-139). O-138's `I1` on Bonereach is a wall and a column, and the "cell-boundary artefact" reading was **withdrawn** — do not re-derive it. `I8` and `I9` are not yours. Report the `mapgen` line before and after, with counts |
| UI-14 | D-104 in full: the arithmetic is 302 shipped against 817 intended, ~100 unshipped `09` §14.3 rows, **58 renames to reconcile rather than duplicate**, 131 RU gendered variants. `13` §9.1's twenty do-not-redefine keys go in verbatim. `ui.adj(key, gender)` is `t(key + '.' + gender)` with a fallback to `t(key)` so English needs no extra rows. The 2 688 × 4 agreement assertion runs in Node under 40 ms and is the ticket's real proof. `t()` **never throws** — missing keys fall back EN then `[missing]` |
| PLYR-6 | `XP_TABLE` is **imported from `combat`**, never copied — D-38 exists because a table was duplicated once. `OPENING_RAMP`'s literal is at `13`:169–177 and PLYR-4 already consumes it by name from this file, so do not rename it. `tools/balance.mjs` is lead-owned and granted for **`--progression` only**; follow the shipped CLI (D-48) — `=`-form flags, `--json` a boolean switch, exit 0/1/2, `checks[]`, `NOTE` never changing the exit code. **13.P01/13.P02 are yours** (D-103) |
| WRLD-11 | D-97: the town is `07` **§2**; the files are `data/last_bastion.js` + `build/town.js`. §2.2's seven arrays and §2.3's map go in **verbatim** — you are transcribing an authored layout, not generating one. D-99: 310 footprints and 0.54 ms are **estimates**; your asserts are the map, the fixture, `regionCount === 1` and p95 ≤ 2.0 ms. Format rule 5 (`PROPS[i].n` vs `POINTS.length / 5`) is a **load-time** failure, not a test. `data/` is a headless lint root; `build/` carries the pointed `three` exception (D-78). **Blesses `town_overview`** |
| AI-10 | D-108 in full, all six traps. `06` §7's pattern tables and §7.9's uptime tables go in **verbatim**; §14.3's RNG draw order is reproduced **exactly**, per cast, because `12.D04` will read it. The arena's anchors are **read**, not re-derived. `boss:phase` fires **at spawn with `phase: 1`**, not only on transitions (`02`:1135), and `bossPhase` is **never assumed monotonic** across a zone or arena reset. The 0.20 s global hit-stop has a constant waiting for you at `src/combat/reaction.js:243` — wire it, do not redefine it. **O-92** (`actor:despawn` contracted and emitted nowhere) is live here: the phase-I adds despawn 4.0 s after the transition, so you are the first real despawner. **Blesses `altar_arena` and `boss_phase_2`**, both under D-113's honesty rule |
| WRLD-12 | D-98's three corrections: Bonereach's gate, the stash chest, the pinned `NpcDescriptor`. `interactableAt` returns the **nearest enabled** interactable through a **shared scratch record** — `Alloc = no`, and that means O-137's definition of `Alloc: no`, one boxed return and nothing beyond it. `enabled: false` hides the prompt; it does not remove the interactable |
| PLYR-7 | `13` §4.3's kit table goes in **verbatim**, including the pre-spent hotbar point — that point is *why* invariant 4 carries its `− Σ classStartSkills` amendment, and a kit that forgets it fails validation on all three classes. The name pattern is **Cyrillic-extended** (D-107). `CLASS_START_KIT` comes from PLYR-6's file; do not restate it |
| PLYR-8 | D-102: the spec is **`11` §6.7 and `03` §10.6**, not `11` §8 (which is Level up). The **`clvl ≥ 5` floor** is in both sources and absent from the backlog's Done-when — an implementation matching the backlog penalises the level-1 deaths `13`:255 describes as expected. `town_spawn` does not exist; the tag is **`town_start`** (D-100). Dying calls `world.closePortal`, which is why the field zone is never retained across a death. **13.P03 and L11's clamp are yours** |
| AI-11 | D-109 in full: import from `src/world/spawn.js`, **merge** into the `'difficulty'` layer, MB6 stays a loud skip tagged M7. §11.3's seven behaviour rows are the deliverable and each is a named mechanic, not a multiplier. §11.5 is equally binding: **no new patterns for Molgrim** — his three phases are identical at every tier and only his numbers scale — and **no committed telegraph window changes at any tier**. `mapgen --difficulty=` is your third micro-scope |
| PLYR-5 | **§3.2 is the only step numbering** (D-101), and the table goes in verbatim. `advanceQuest` is monotone — a replayed `zone:ready` is the *expected* input, not an edge case, and the acceptance is literally five replays awarding 3 400 XP once. Quest XP is `grantXp(amount, 0)`, **never scaled by `levelPenalty`** (`13`:463). L4 is yours: `player` calls `world.setExitSealed` on `quest:update` **and** `zone:ready` — both, because a reload lands you in a zone without a transition |
| SAVE-2 | D-106's four sub-rulings. The autosave writes to `…tmp` **and swaps** — a direct write is the one failure mode that loses a character. `cursorItem` is an optional default-null field and invariant 8 counts it. **`INVARIANT_COUNT` becomes 17**, and 16/17 come from `13` §2.4, not from `01` §10.3 (which has fifteen rows, while `12`:398 says "all 17" — the two documents split the list) |
| PLYR-9 | This is the **only irreversible grant in the game** (`13`:1808). `skillBonuses.all += 1` lands on the **`quest`** stat layer: effective levels rise by exactly 1, **no allocated level changes**, synergies read allocated levels so nothing compounds, and it survives a respec. `questSkillPointsGranted ∈ {0,1}` is invariant 17 and is the anti-cheat. A full inventory produces `reward.held` and the item **survives a reload** — test the reload, not the branch. Your deps include **AI-10**, whatever the backlog says |
| UI-12 | UI-14 lands first (D-104); if a key is missing, **report it, do not invent it**. The four wireframes are geometry, not suggestion. DOM budgets **105 / 108 / 12** are measured asserts via `ui.__nodeCount`, and the page cap is **700** with a recorded worst realistic total of 543 — the ~157 nodes of headroom are shared with UI-13, which has **no budgeted row at all**. `09`'s hard rule holds: everything animates by integrating `dt` in `lateUpdate`, **no CSS transitions**. The quest tracker rebuilds **only** on `quest:update`, asserted by counting. **O-78** is half-open — `ui.pointerOverUi` never got its markers in `inventory.js`/`hud.js`, and a vendor click that also walks the character is the failure it exists to prevent. **Blesses `vendor_open`** |
| UI-13 | Six screens (D-105), `reward_choice` included and rendered here while PLYR-9 grants behind it. The death screen's 3.0 s lock and the menu's hover slide run on the **raw clock**, which is the documented exception, not a licence elsewhere. The creation preview renders into `ctx.uiScene` and **nothing else joins it**. Every option row writes through `save.saveSettings()` and survives a reload — that is a `save` round-trip test, not a DOM test. Your screens have **no DOM budget row**; measure and report what you spend |
| SAVE-3 | One file, pure functions, ascending order, each intermediate passing §10.3 **for its own version**. `SCHEMA_VERSION` stays 1 (D-106), so prove the framework against a **synthetic v0 fixture** — a framework that has never migrated anything is exactly what rule 4 forbids. A bump without a fixture must **fail the build**, and that check is part of this ticket, not TEST-10's |
| TEST-10 | `tools/` is lead-owned (`ARCHITECTURE.md:112`) — `tools/save-fuzz.mjs` and `tests/fixtures/saves/**` are granted and nothing else is. The three jobs run **in order** and each reports its own counts: 5 000 round-trips, every fixture × all 17 invariants with **a missing fixture failing the run**, 8 000 mutants quarantined. **A mutant that loads and produces an invalid character is reported separately from one that crashes** — that distinction is the point of the harness. Shipped CLI (D-48), exit 0/1/2, `skip` reported loudly |
| TEST-11 | D-112 in full. A **scripted input sequence, not a bot**. `--campaign`, three seeds, B01–B08 per seed, `13.P04` at level 13 ± 1. `12.B07`'s identical end-state hashes use `12` §7's canonical projection (every actor's `id, x, z, life, mana, secondary, state, actionSeq`, every ground item's `uid, x, z`, each stream's RNG position, `ctx.time.step`) — do not invent a hash. Anything unmeasurable reports `skip` naming M9. **O-40 is live**: `src/physics/separate.js` reads `performance.now()` inside the fixed step, so if two runs at one seed ever diverge, look there before you look at the campaign |
| every ticket | **O-12 is granted to nobody in M6.** No new subsystem is registered this milestone, and **O-98** is why it matters: registration order shifts every subsequent subsystem's RNG stream, which would move every layout hash in the project |
| every ticket | **O-27 / O-39**: a test written before a subsystem encodes "nothing exists yet". It has now bitten **eleven** times. Never assert counts of subsystems, zones, archetypes, panels, screens, keys or exact pixels, and never write `typeof x.method === 'undefined'`. Assert the behaviour the test exists for |
| every ticket | A public method exists only if `02-api-contracts.md` lists it, **with its `Fixed` and `Alloc` columns**, and must be reachable **as a method on the subsystem the contract names** — O-71 is the M3 precedent where `items` shipped contract methods as module functions and the contract read as satisfied. M6 adds more API surface than any milestone since M3; **you** are the check, at acceptance |
| every ticket | Any new method whose contract row says `Alloc = no` must be **added to `12.A01`'s probe list**, and `Alloc: no` means O-137's definition: at most one boxed return value, pinned exactly |
| every ticket | **A test pinned to a defect must fail when the defect is fixed.** Confirmed six times, most recently at O-139 and O-137. When a ticket turns somebody else's test red, your first question is whether that test was standing on a bug |

### 4.4 Open debts entering M6

Assign each to a named M6 ticket in your first report, or tell the owner plainly
it is carried to M7. Do not let them drift — the O-table is now 147 entries long
and a third of it is carried debt.

**Newly live because M6 touches them:**

- **O-145 / O-133 — the player freezes in combat.** Closed by **PLYR-11**
  (D-95). Verify it actually closes: the ticket's own test is the proof, and the
  M5 gate item ⑪ re-run is yours.
- **O-107 / O-138 — the Wastes entry region and Bonereach's `I1`.** Closed by
  **WRLD-13** (D-96). O-140's 41 residual chests close with them or the fix is
  incomplete.
- **O-147 — the corridor chain-break under mass.** **Owner decision**, requested
  in your first report. If the owner rules for the formation fix, it is
  micro-ticket `AI-13`.
- **O-92 — `actor:despawn` contracted and emitted nowhere.** **AI-10** is the
  first real despawner (phase-I adds at the I→II transition). The owner was
  recorded as AI-8/M6 and AI-8 did not close it; M6 can.
- **O-97 — no difficulty-tier system exists anywhere.** Closed by **AI-11**
  (D-109), and its closure is what makes `mapgen`'s third dimension real.
- **O-131 — no corpse lifecycle owner; `Actor` has no `resurrectCount`; pool
  slots leak.** `pool.js:169` records it as "ACTR-17/AI-9". **AI-10** creates
  eight boss adds that despawn on a timer, which is the same shape. Decide who
  fixes it or record that it is carried again.
- **O-49 — status pool slots leak on despawn** unless `clearStatuses` runs before
  `pool.release`. Same neighbourhood as O-131; same decision.
- **O-132 — `keepQuestCritical` holds nothing** (`a.questCritical` does not
  exist) and `cleared` goes stale on pickup. **Molgrim is the one bearer of the
  quest-critical flag** (`src/ai/spawn.js:905`) and **AI-10** is the first ticket
  that can make the flag mean something.
- **O-127 — `items` does not clear the ground on `zone:teardown`**, so one zone's
  floor leaks into the next. Nobody in M5 had a grant; nobody in M6 does either,
  but **TEST-11's campaign walks four descents** and will see it. Report loudly.
- **O-111 — `projectile:spawn` / `projectile:end` are never emitted.** Recorded
  owner: `fx`, M6. There is no `fx` ticket in M6. Carry it explicitly to M8.
- **O-56 — the M2 gate's respawn half.** Closed by **PLYR-8**. It has been open
  for four milestones with the note "PLYR-8, M6"; close it and say so.
- **O-60 / D-22 — `vendor_open`.** Closed by **UI-12** (D-110), on its second
  deferral.
- **O-70 — `i18n.js` carries no combat keys** while the feedback layer calls
  them. Closed by **UI-14** or explicitly carried.
- **O-83 — `HudState.secondaryDecay` has no owner.** Was M4's; M4 closed without
  it. **UI-12/UI-13** open the UI neighbourhood; decide.
- **O-93 — `tests/ui/target.perf.test.js` flakes on its threshold.** Assigned to
  UI-11, which did not settle it. Reassign to **UI-12** and settle it by
  measurement.
- **O-124 — `03` §9.3's resist columns are applied nowhere**, which shortens
  champion life. **AI-11** implements per-tier monster resists (+0/+20/+40) and
  will meet it head-on; `src/ai/data/affixes.js:267` already carries the table
  deliberately unapplied to avoid double-counting. Resolve it there or record it.
- **O-99 — `NavGrid.groundY` is filled by nothing**, so `passN3Slope` is a
  permanent no-op. **WRLD-11** builds the first zone with authored terraces and
  a cistern; report whether it matters there.
- **O-120 — `NAV_FLAG.interior` is unreachable for every zone**, which mutes
  D-83's remedy. **WRLD-11**'s town is the natural place to find out why.

**Carried, and still nobody's:**

- **O-128 — no actor renders.** M7/M8's, by the backlog. It makes every M6 shot
  partial (D-113) and it means the campaign in `playtest.mjs` is proved by state,
  never by sight.
- **O-40** — `src/physics/separate.js` reads `performance.now()` inside the fixed
  step. **The determinism hole, and `12.B07` is a determinism assertion.** If two
  campaign runs at one seed diverge, look here before you look at the campaign.
- **O-87** — `actors.moveSpeed` ignores `StatBlock.movementSpeed`, so every slow
  and every haste is cosmetic. AI-11's Trial/Renunciation behaviours and
  Molgrim's 3.0 m/s walk both assume it works.
- **O-105** — an attacking monster has no steering avoidance; bodies press to
  0.084 m. PLYR-11's standing candidate; if it is not the cause, it is still
  true.
- **O-114 / O-115** — mixed packs cannot exist (`world` passes the wrong
  identifier) and `perception.js#registerPack` leaks across zone loads. **Four
  descents in one session** is exactly the workload that surfaces the second.
- **O-135** — every `Alloc: no` probe except one still divides by the wrong
  denominator.
- **O-101** — `nav.stats` has no public `solved` counter and `refusals` counts
  something else. MB12 reads it.
- **O-109** — `ember_bolt`'s harness TTK is 19 % off its printed value. MB5's
  Emberwright arm is a TTK number.
- **O-118 items 2, 4, 5, 6, 9** — the residual generator defects table.
- **O-46, O-47, O-52, O-45, O-1** — read their rows; none binds an M6 ticket, and
  each should be re-affirmed as carried or closed.

### 4.5 Tooling traps (yours, when verifying)

- **O-26**: `tools/capture.mjs` does **not** rebuild `dist/`. Always
  `npm run build` first, or you bless a frame from stale code. This bites all
  four M6 shots.
- **O-50 is fixed** — `shot.setup` runs inside the page. If a new shot comes back
  byte-identical to `boot_clean`, suspect `setup` before the renderer. And
  remember **O-128**: a frame that looks empty may be correct.
- **O-20**: `--test-name-pattern` must come **before** the glob, and the glob must
  be quoted. Flag after glob silently filters nothing.
- **O-28**: `tests/tools/capture.test.js` boots `vite preview` + Playwright at
  file level, so it runs even under a name filter. Target a directory
  (`tests/player/`, `tests/save/`, `tests/ai/`) when you want a fast run.
- The perf stage is `--test-concurrency=1` and already takes ~5 minutes. A new
  file joins it by being named `*.perf.test.js`. If a test flakes, the fix is
  isolation or the measurement — **never** a retry, never a loosened threshold.
- `tools/check-imports.mjs` **contains embedded null bytes** — plain `grep`
  silently finds nothing in it. Use `grep -a`.
- **Eight shots are blessed** and all must stay at `diffPixels=0` through M6:
  `boot_clean`, `ui_clean`, `inventory_full`, `skill_tree_ravager`,
  `wastes_seed_a`, `wastes_seed_b`, `bonereach_hall`, `dense_combat`. The
  `actor_*` shots and `ui_icons` render but have no committed fixture;
  `ui_icons` is deliberately never blessed.
- `src/save/` is a **full lint root** (`checkThree` and `checkGlobals`): no
  `three`, no `document`, no `window`, no `localStorage` **at module scope** —
  `store.js` must reach the browser API through a guarded accessor, because the
  Node test surface has no `localStorage` at all. This is the single most likely
  way SAVE-2 kills every headless test in the project.
- `tools/` scripts run under plain `node`. `save-fuzz.mjs` and `playtest.mjs`
  must not import `three` transitively; `playtest.mjs` drives a **built** page
  through Playwright, exactly as `capture.mjs` does.
- The imports lint's **file count rises from 119** as `src/world/build/town.js`,
  `src/world/interact.js`, `src/player/*`, `src/save/*` and `src/ui/*` land. If
  it does not rise, a file is not where the lint expects it.

## 5. The loop, one ticket at a time

For each ticket in the order of §3.2, subject to §3.4's lane rules:

**5.1 Confirm readiness.** Deps closed? Owned files free of any concurrent agent?
If the previous ticket is not accepted, you do not start what depends on it.

**5.2 Build the brief.** Extract only the named spec sections. Target
**1500–4000 lines** of context per ticket. `13` is 1931 lines, `06` is 3313 and
`09` is 3232, and no single ticket needs any of them whole; if a brief approaches
those numbers you have taken the document instead of the slice. For **AI-10**,
`06` §7's pattern tables, the transition timeline and §7.9's uptime tables go in
**verbatim** — the agent is reproducing printed numbers, not deriving them. Same
for **PLYR-7** (`13` §4.3's kit table), **PLYR-5** (`13` §3.2's seven steps),
**WRLD-11** (`07` §2.2's arrays and §2.3's map) and **UI-12** (`09` §3.5's four
wireframes).

**5.3 Spawn one Sonnet 5 subagent.** One ticket, one agent, named after the
ticket:

```
Agent(
  name: "AI-10",
  description: "Molgrim: three phases",
  model: "sonnet",
  subagent_type: "general-purpose",
  run_in_background: false,
  prompt: <the §6 template>
)
```

Never give one subagent two tickets "while it has the context" — it will start
editing outside its directory and the ownership rule stops protecting anything.

**5.4 Verify it yourself.** The subagent's report is a claim, not a fact. Run §7
in full. M5 recorded four separate occasions where a subagent's stated root
cause was *plausible and wrong*, and twice it was the orchestrator's own recorded
baseline that disproved it. **Measure the baseline before every ticket.**

**5.5 Accept or send back.** Accepted → journal entry in `docs/PROGRESS.md` →
next ticket. Not accepted → §8.

## 6. Subagent brief template

```
You implement exactly one ticket of a game engine. Work strictly inside the
files named below. You run on Sonnet 5; the orchestrator will re-verify
everything you claim, by running commands.

## Ticket <ID> — <title>

Files you may touch (and no others):
  <corrected Files list, plus any explicitly granted extra file>

If you find you need a file that is not listed, stop and say so in your report
before writing it. The backlog's Files columns are known to be incomplete and
another agent may be holding what you want.

Acceptance criterion (the orchestrator will run this, not eyeball it):
  <the corrected Done when — §3.2, not the backlog's row>

## Engine contract — read this first, it is binding

<full text of docs/ARCHITECTURE.md>

## Specification for this ticket

<only the named sections, extracted from docs/spec/*.md. Quote 06 §13's and
07 §12's rows rather than citing them as sections — they are table rows, not
headings — and then include the real algorithm section the row stands for.
13-progression-lore.md's L0..L12 are rows of the §12 table, not sections.
If the ticket has a printed table as its criterion (06 §7, 13 §3.2, 13 §4.3,
07 §2.2/§2.3, 09 §3.5), paste it verbatim.>

## Project state you must respect

<the relevant rows from §4: performance rules, the ticket's own O-nn / D-n
entries, the resolved file-name and criterion corrections>

## Rules

1. You own only the files listed above. Editing any other file is a defect and
   will be reverted. If you need someone else's file, say so in the report —
   do not edit it.
2. No new dependencies. `three` only, and gameplay/math code must not import it
   at all. `src/world/`, `src/nav/`, `src/ai/`, `src/player/`, `src/save/` and
   every `data/` directory are headless lint roots: no `three`, no `document`,
   no `window`, no `localStorage` at module scope, no `performance.now()`,
   transitively. `src/world/build/` and `src/materials/` are the exceptions
   where `three` is legal.
3. No `Math.random()`. Use `ctx.rng` or your own `ctx.rng.fork()` taken once in
   `init()`. The boss draws in the order 06 §14.3 prints, and nowhere else.
4. Simulation lives in `fixedUpdate` (60 Hz) and never reads `dt` or the wall
   clock, including `performance.now()`. Presentation lives in `update`.
   Schedule against `ctx.time.step`. Cooldowns, wind-ups, phase timers, enrage
   clocks, autosave intervals and quest timers are all fixed-step quantities.
   The two documented raw-clock exceptions are the death screen's 3.0 s lock
   and the main menu's hover slide; nothing else.
5. Zero allocation per frame. Vectors, pools and scratch buffers are built in
   `init()`. `Math.hypot` is banned — use `Math.sqrt(x*x + y*y)`. `Map` is
   banned for recycled or pooled state, and `Map.prototype.clear()` allocates
   even when the map is empty; the house idiom for recycled slots is a
   generation stamp in a flat typed array. Template strings in a hot path
   allocate — dispatch on an integer index resolved once, not on a string id.
   `Alloc = no` means at most one boxed return value and nothing beyond it.
6. Gameplay numbers live in `data/`, not in code. If the specification does not
   give you a number, stop and ask — do not choose one.
7. A public method exists only if `docs/spec/02-api-contracts.md` lists it, with
   its `Fixed` and `Alloc` columns. If you need a new one, say so in the report
   and wait — another agent may be holding that file. A contract method must be
   reachable as a method on the subsystem the contract names, not only as an
   exported module function.
8. `npm run build` must pass and `npm run capture` must still produce a frame.
   Breaking the boot blocks every other ticket.
9. Do not write tests outside your ticket and do not touch fixtures or blessed
   PNGs. A test that asserts a time, an allocation or a frame goes in a file
   named `<thing>.perf.test.js` so the runner isolates it. Do not commit a red
   test — a red test in the suite breaks the milestone gate.
10. Git: no commits, no pushes, no branch operations. And specifically: no
    `git stash`, `checkout`, `restore`, `clean`, `reset`. Another agent may be
    working in the tree right now. Need a file out of the way? Rename it.
    (This has been violated once, in M3, by an agent that believed it was
    being careful.)
11. Do not assert "nothing else exists yet". Counts of subsystems, zones,
    archetypes, panels, screens, i18n keys and exact pixels all change every
    milestone; assert the behaviour your test exists for.
12. If your criterion is a sweep or a session, report the counts — how many
    seeds, characters, mutants or steps ran, and the distribution of the
    quantity being bounded. A harness that meets a budget by running fewer
    cases does not pass, and a check that cannot run reports `skip` loudly,
    never silence.
13. Do not add game content. No seventh archetype, no fourth boss phase, no
    tenth affix, no fourth zone, no new item. The shipped lists are the shipped
    lists until M7, and 06 §13 says "no fourth boss phase" in as many words.

## Self-check before you report

Run, and paste the real output:
  - npm run build
  - npm test              (or the focused directory, plus the full suite once)
  - npm run lint
  - the exact command that demonstrates your acceptance criterion, with counts

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
2. **The ticket's own criterion.** The exact command from the corrected
   "Done when". If it is an assertion id (`MB15`, `12.B06`, `13.P03`), run the
   harness that produces it — do not settle for "the file exists".
3. **Read the counts, not the verdict.** A session reports how many steps it
   ran, a fuzzer how many mutants, a campaign how many seeds. Check that the
   first number is the number you asked for. 8 000 mutants is 8 000. A
   `save-fuzz` that quietly ran 800 reads exactly as green.
4. **Re-derive one number by hand, for every ticket that carries one.** Pick an
   intermediate the agent did *not* highlight: one phase's uptime out of the
   schedule, one XP band out of `13` §1.4, one death penalty at clvl 17, one
   ledger line out of UI-12's town loop, one invariant's failure message.
5. **Tests.** `npm test`, both stages. For perf- or GC-sensitive tickets run it
   more than once, and never while a subagent is working (§3.4). Remember O-85,
   O-93 and O-117 before you call an allocation probe a regression.
6. **Lint.** `npm run lint`. Confirm the file count rises from **119** as new
   files land, that `src/save/` did not acquire a `localStorage` reference at
   module scope, and that `src/world/build/town.js` is the only new file legally
   importing `three`.
7. **Read the diff.** `git status --short`, then `git diff` over the ticket's
   files. Six things tests do not catch:

   | What | How you catch it |
   |---|---|
   | edits outside the owner directory | `git status --short` shows extra files |
   | importing another subsystem directly | `grep -rn "from '\.\./\(actors\|combat\|nav\|world\|physics\|items\|ui\|skills\|player\|save\)" src/ai src/world src/player src/save` — must be empty; everything goes through `ctx.get()` |
   | `Math.random()` | `grep -rn "Math.random" src/` — exactly one legal hit, in `src/main.js` |
   | allocation in the frame | array/object literals, template strings and `Map` inside `update`/`fixedUpdate` or any `Alloc = no` method |
   | wall clock in the fixed path | `grep -n "dt\|performance.now\|Date.now" <file>` inside `fixedUpdate` — see O-40 |
   | gameplay numbers hard-coded | magic constants where the spec says `data/`; a duplicated `XP_TABLE` or `DIFFICULTY_MLVL_OFFSET` is D-38's incident repeating |

8. **Independent behavioural probe.** Do not just rerun the subagent's test —
   write your own throwaway check in the scratchpad and compare. M0 rejected four
   tickets this way, M1 two, M2 several, M3, M4 and M5 more.
   **M6's highest-value probe is a scripted session through a real `boot()`**,
   and it is the same probe at increasing length all milestone: create a
   character → walk the town → take the quest → descend → fight → die → respawn →
   reload → continue. Run the longest version the tickets landed so far support,
   every time. It catches what every unit test in this milestone will pass — a
   game whose parts all work and whose campaign cannot be finished.
9. **Frame.** `npm run build && npm run capture`, then `imagediff` against the
   blessed baselines. The eight existing blessed shots stay at `diffPixels=0`
   throughout M6; if one moves, find out why before you re-bless anything. For
   the four new shots: **look at the PNG with your own eyes** before blessing,
   record in the journal that you did, and say what the frame does **not**
   contain (D-113).

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
causes. A fourth round on the same prompt never works. `AI-10` is the ticket most
likely to need all three; budget for it rather than being surprised.

## 9. The journal

`docs/PROGRESS.md` is the only file you write. One row per **accepted** ticket,
appended to the existing table, matching its columns:
`ID | Дата | Файлы | Проверено чем | Заметки`, with the round count in the date
cell (`2026-08-06 (2 круга)`). A subagent's report is not a row; your own
verification is.

**Write the row when you accept the ticket, not at the end of the milestone.**
This has now failed twice — nine reconstructed rows in M4 (D-60), ten in M5
(D-88) — and the second time was after the first was written up as a lesson. If
you find yourself with three accepted tickets and no rows, stop and write them
before the fourth.

Keep the rest of the document alive too:

- **§1.1's M5 gate table lands first**, twelve rows with honest verdicts, and the
  status line is corrected in the same pass;
- **D-94…D-113 get written down as D-entries** so M7 does not re-litigate them;
- new interface questions go into the O-table with an owner ticket, continuing
  from **O-148** (O-147 is the highest in use);
- new decisions continue from **D-114** (D-113 is the highest in use);
- a question you resolve gets its resolution written down. M6 should close
  **O-145**, **O-107**, **O-138**, **O-97**, **O-56**, **O-60**, **O-92**, and
  must record an answer for **O-147**, **O-49**, **O-93**, **O-99**, **O-111**,
  **O-120**, **O-124**, **O-127**, **O-131** and **O-132**;
- a performance finding that cost someone a rewrite goes into the rules section;
- update the status line at the top and add M5's and M6's rows to the
  milestone-gate table.

The document exists so a fresh session understands the state in one minute
without rereading 200 tickets. It is 5 676 lines and that reader is now
hypothetical — M6 is the milestone to either restore that property or say plainly
that it is gone.

## 10. The M6 gate

When all 18 tickets are accepted, run the gate — and do not treat it as a
formality:

| # | Check | Source |
|---|---|---|
| ① | `npm run build` green | backlog, definition of done |
| ② | `npm test` green, **several consecutive runs**, both stages | M0–M5 precedent |
| ③ | `npm run lint` green, file count risen from **119**, `src/save/` clean of browser globals at module scope, `src/world/build/town.js` the only new `three` importer | 12 §2.1, D-97 |
| ④ | **The game is completable, as one real session through `boot()`**: create a character, four Instruction descents, kill Molgrim, take the reward, Trial unlocks. Driven by you, not by a test file | backlog M6 gate — *the* M6 gate |
| ⑤ | **`node tools/playtest.mjs --campaign` green on three seeds**, with `12.B01`–`12.B08` asserted **per seed**, `12.B07`'s two runs at one seed producing identical end-state hashes, and every unmeasurable assertion printing a loud `skip` naming M9 | 12 §5.6, §11, D-112 |
| ⑥ | **`node tools/save-fuzz.mjs` green** — 5 000 round-trips to deep equality after `rebuildCache`, every committed fixture × **all 17** invariants with a missing fixture failing the run, 8 000 mutants quarantined and never crashing the boot | 12 §5.4, D-106 |
| ⑦ | **`13.P01`–`13.P04` pass** as defined in §4.2 D-103, and `node tools/balance.mjs --progression` is green | 12 §11, D-103 |
| ⑧ | **`node tools/balance.mjs --boss` green** — MB5 (60.0–90.0 s, all three builds), MB5b (< 150 s), MB15 (per-phase uptime within ±0.05 of `06` §7.9) | 06 §13 row 10, D-108 |
| ⑨ | **The tiers hold**: MB2, MB3, MB4, MB5, MB5b, MB7, MB8 re-run at Trial and Renunciation and MB11 at every tier; MB6 reports `skip` naming M7 | 06 §13 row 11, D-109 |
| ⑩ | **`town_overview`, `altar_arena`, `boss_phase_2` and `vendor_open` registered, captured, reviewed by eye, blessed and committed**, each with an honest `description` naming what the frame does not contain | 12 §9.1, D-110, D-113 |
| ⑪ | **M5's four red items closed or owner-acknowledged**: ⑪ green by `PLYR-11`, ④ improved by `WRLD-13` with the residue named, ⑥ and ⑧ carrying an explicit owner ruling | D-94 |
| ⑫ | M2–M5 must not regress: `03.E01`–`E14` still exact; `lootsim` green with `12.D03`/`12.D08`; `balance --skills` green; `balance --monsters` and `mapgen` **no worse than the §1.2 baseline**; `12.A01`/`A02`/`A05` green with every new `Alloc = no` method in `12.A01`'s list; all **eight** existing blessed shots at `diffPixels=0` | M2–M5 gates |

Item ④ is the milestone, and it is the only check that proves M6 produced a
*game* rather than sixteen subsystems. Run it as one continuous session — not as
a battery of tests each covering a leg — and write down what you saw at each
stage. It is also the check that will fail for reasons no ticket owns: a leaked
pack, a stale `cleared` flag, a ground floor from the previous zone. That is what
it is for.

Item ⑤ is the easiest to fake, in two directions: a campaign that runs fewer
seeds than it claims, and an assertion that passes because it was never
implemented. Read the printed counts and read the assertion implementations, not
just the exit code.

Item ⑩ is easy to fudge, and under O-128 it is easy to fudge *honestly by
accident* — a frame with no actors in it looks like a frame with a bug. Say
plainly what each one contains.

Red gate = milestone not closed. And be careful with that sentence: M5 ended red
and this prompt is the consequence. If M6 ends red, the honest move is the same
one made here — name the items, assign them, and hand M7 a truthful state — not
a green declaration.

**When the gate is green, stop.** Do not start M7. Report to the owner: tickets
closed, gate results item by item, what was hard, which specs proved wrong or
ambiguous, what should be revisited in the plan. M7 starts on a direct order,
exactly as M1–M6 did.

## 11. Git

**No commits. No pushes.** Not by you, not by subagents. Take the work to
"changes are ready" and stop. The owner grants commit permission separately and
freshly each time; permission from a previous turn does not carry over. No
`rebase`, `reset --hard`, `merge`, branch or tag deletion.

**Also forbidden: `git stash`, `checkout`, `restore`, `clean`, `reset`** —
anything that touches the working tree as a whole. M0–M5 are committed at
`8b8f6de`, so there is a real restore point; M6's in-flight work is not, and with
two or three lanes running there may be three tickets' worth of uncommitted code
in the tree at once. An agent already violated this once, in M3, while believing
it was being careful. If you need a comparison against an older tree — M5 needed
one for a bisection — use a **separate `git worktree`**, which is what the
previous orchestrator did.

`docs/PROGRESS.md` is the only file you write yourself.

When M6 closes, say the work is ready and offer to commit — then wait.

## 12. Stop and ask the owner when

- two documents require **incompatible** things — a contradiction, not an
  ambiguity. Everything of this kind that was known on 2026-08-05 is already
  ruled on in §4.2. So this applies to what you find **new**, and you should
  expect to find some: `13-progression-lore.md` has already contradicted itself
  in five places about a single integer, and it is the document this milestone
  is built on;
- a ticket needs a **number no spec provides** — never invent one. M4 recorded
  one fabricated curve and one number that lived in a document nobody would have
  opened (D-47); M5 found eleven criteria that did not follow from their own
  document's arithmetic. Assume there are more; `13` §1's XP tables and `06`
  §7.9's uptime derivations are the likely sites;
- a documented table, trace or worked example does not reproduce *and* the
  implementation looks right. That is a finding about the spec — not a licence to
  adjust the expected value or widen the tolerance. **Five times in one M5
  session** the failure mode was a check weakened by exactly enough to pass;
- the gate stays red after three attempts;
- something would add **game content** — a fourth boss phase, a seventh
  archetype, a tenth affix, a fourth zone, an item, a quest step. `06` §13 and
  plan §10 both forbid it before M7;
- the work would go outside the backlog.

Do not stop for routine: private function names, file layout inside your own
directory, field order. Decide and move.

**Four things are already queued for the owner in your first report** (§14):
O-147's variant (б), the three remaining `--monsters` failures, `I8` on the
Wastes, and `I9`'s unjudgeability until `src/sky/` exists.

## 13. Reporting

Per ticket, short:

> `PLYR-6` accepted. `src/player/data/progression.js`, `tools/balance.mjs`
> (`--progression`, granted micro-scope). `npm run build` green, `npm test`
> 2483/2483 across both stages. `--progression` reproduces §1.4 **to the unit**
> on all four descents — I re-derived descent 3's 1 675 (×0.91) by hand rather
> than trusting the assert — and §1.5's Trial and Renunciation totals 173 565 and
> 317 106. Boss levels **13 / 24 / 30**, asserted, not printed. `XP_TABLE` is
> imported from `combat`; I grepped for a second copy and found none.
> **13.P01 and 13.P02 green.** Next: `WRLD-11`.

Per milestone, a table: tickets, gate results, what surfaced, what to revisit.
Do not narrate diffs. The owner tracks state and blockers.

**One reporting rule specific to this milestone**, and it is written in the
journal at the cost of two bad owner rulings: **when you summarise a measurement
for a decision, give the owner the number and the command, not your reading of
it.** `PROGRESS.md:5672–5676` records two rulings made in good faith on
summaries that were wrong — *"источник ошибки — не владелец и не код, а сводка
между ними"*. If you are recommending a choice, show the output it rests on.

## 14. Start here

1. Read the six items in §2 — including `13` §12, §2 and §3, `06` §7 and §11,
   and `12` §5.4/§5.6/§11 in full, before anything else.
2. Run `npm run build`, `npm test`, `npm run lint`, `node tools/balance.mjs
   --skills`, `node tools/balance.mjs --monsters`, `node tools/mapgen.mjs`,
   `node tools/lootsim.mjs`, `git status --short` and `git log --oneline -3`, and
   record the real baseline against §1.2. You will need it to prove nothing was
   lost — and twice in M5 it was the baseline that disproved a plausible
   diagnosis.
3. **Close §1.1's bookkeeping** — write the twelve-row M5 gate table into
   `PROGRESS.md`, fix the status line, and confirm all eighteen M5 rows are
   present. This comes before ticket 1 and takes half an hour.
4. Walk §4.2 and **verify** each of the twenty rulings against the current
   files — do not take this prompt's word for any of them; line numbers drift and
   the tree moves. You are checking they still hold, not deciding them again. If
   one does not hold, say so in your first report; otherwise say "twenty rulings
   verified" and move on.
5. **First report, for information, not for permission:** the twenty rulings
   verified (or the exceptions), the measured baseline, the state of M5's four
   red items, and what happens to O-92, O-97, O-49, O-56, O-60, O-93, O-99,
   O-111, O-120, O-124, O-127, O-131 and O-132 in M6, ticket by ticket, or that
   they are carried. **Four things in it are for the owner**: O-147's variant
   (б), the three remaining `--monsters` failures, `I8` on the Wastes, and `I9`.
   Then keep going — you do not wait for an answer to start ticket 1.
6. Create tasks (`TaskCreate`) for the 18 M6 tickets in the §3.2 order, so
   progress is visible.
7. Report the plan: 18 tickets, `PLYR-11` alone first, then `WRLD-13` alone, then
   three lanes —
   `world/quest: WRLD-11 → WRLD-12 → PLYR-5 → PLYR-9`,
   `ai: AI-10 → AI-11`,
   `ui/save: UI-14 → UI-12 → UI-13` alongside `PLYR-6 → PLYR-7 → PLYR-8` and
   `SAVE-2 → SAVE-3` —
   with `TEST-10` after `SAVE-3` and `PLYR-9`, and `TEST-11` last and alone.
8. Launch `PLYR-11` — and measure before you grant it a file.



