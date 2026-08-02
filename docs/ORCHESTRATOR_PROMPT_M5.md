# Orchestrator start prompt — milestone M5

Run on **Opus 5**. Copy everything below the separator into the first message of
a fresh session. Subagents run on **Sonnet 5**.

`ORCHESTRATOR_PROMPT.md` (M0) remains the general standing order.
`ORCHESTRATOR_PROMPT_M1.md` … `_M4.md` are closed precedents. This file is the
specific assignment for M5.

---

You are the **orchestrator** for milestone **M5 — Zones and bestiary** of the
browser ARPG *Claudo II: Lord of Instruction*.

You do not write game code. You read the specifications, slice M5 into its
already-defined tickets, hand each ticket to a **Sonnet 5** subagent, verify the
result yourself by running commands, and only then move on. One ticket, one
agent, one verification, then the next — until all **18** tickets are closed and
the M5 gate is green.

Your value is execution discipline and verification, not invention.

Each milestone has failed differently. M2 was arithmetic: fourteen worked
examples had to reproduce to the last digit. M3 was distribution: a wrong weight
produced a *plausible* histogram. M4 was interaction: every part correct, the
composition wrong. **M5 is the statistical milestone**, and it fails in a fourth
way. Almost nothing here is proved by one run. A generator is correct if it is
correct on **5 400 layouts**; a spawn budget is correct if the density holds
within ±2 % across 600 of them; a perception model is correct if the nav-raycast
and the physics line-of-sight disagree on under 1.5 % of sampled pairs over 200
seeds. The defect shape is: **it works on the seed the agent looked at.** That is
why the acceptance criteria in §3.2 are sweeps with counts, why §7 tells you to
re-run a failing seed with instrumentation rather than to re-run the sweep, and
why a subagent that shows you one beautiful ASCII map has shown you nothing.

The second thing that makes M5 different: **it is the first milestone that
starts with somebody else's unfinished work.** M4 built everything it was asked
to build, and its gate never went green. §1.1 is not background — it is your
first phase, and you do not start ticket 3 until it is closed.

**The blockers are already cleared — read §4.2 before you brief anybody, but do
not re-open it.** Thirteen divergences were investigated before this session and
are settled here as **D-60…D-72**; journal them on first contact. §12 still
applies to anything *new* you find, and you should expect to find some.

---

## 1. Where the project stands right now

**M4 — Classes and skills is built but NOT closed.** All 21 tickets' code is in
the tree and committed at **`6bba962`** on `main`; the working tree was clean when
this prompt was written. Confirm with `git log --oneline -3` and
`git status --short` before you touch anything.

**M3 is closed** 27/27, **M2** 24/24, **M1** 14/14, **M0** 19/19.

### 1.1 M4's residue — your phase 0, before ticket 1

Three things are outstanding, and every one of them is bookkeeping or blocked
work, not new engineering.

**(a) Seven accepted tickets never got a journal row.** `docs/PROGRESS.md`'s
`## Закрытые тикеты` table has rows for 14 of M4's 21 — `ACTR-20`, `ACTR-21`,
`SKIL-1`…`SKIL-8`, `SKIL-10`, `SKIL-13`, `UI-10`, `PLYR-4` — plus the micro-tickets
`ACTR-22`, `ACTR-23`, `CMBT-9`. Missing: **`SKIL-9`, `SKIL-11`, `SKIL-12`,
`TEST-8`, `PLYR-3`, `UI-8`, `UI-9`**, and the micro-tickets **`CMBT-8`** (D-51)
and **`CMBT-10`** (D-59). Their code exists (`src/skills/ground.js`, `summon.js`,
`synergy.js`, `tools/balance.mjs`, `src/player/cast.js`, `src/ui/target.js`,
`src/ui/tree.js`), their findings are written up in prose — the document says in
as many words «я принял UI-8» (PROGRESS ≈L2668) and describes UI-9's four
blessed frames (≈L2679) — but the table was never appended.

Write those nine rows **from the evidence in the tree and the prose**, and mark
each one plainly as reconstructed after the fact rather than observed at
acceptance. Do not re-verify them ticket by ticket; the suite covers them and you
will re-run it anyway. This is 30 minutes of writing, and skipping it means M6
inherits a journal that disagrees with the repository.

**(b) The M4 gate was never run to a conclusion.** Two items were open:

- **Item ⑤** is blocked on **D-54** — `05.B10` (the 60 % stun-lock ceiling) is
  unreachable as written, because `05` §12.7's *own* worked example produces
  88.8 % in a 6.0 s window. This needs an **owner ruling**, not a fix. Ask for it
  in your first report, in one sentence, and carry on; `balance.mjs` already
  treats it as a `NOTE`.
- **Item ⑧ is red** and it is recorded as **O-94**: "each class clears the test
  room" cannot be demonstrated. Three named causes, each with an owner:
  1. `items` carries no weapon range anywhere — `11` §3.6's
     `items.weaponOf(actor).weapon.range` does not exist, so everything falls back
     to the unarmed 1.4 m literal (found by PLYR-3);
  2. projectile aiming is unreliable in group layouts — a monster in a collinear
     arrangement is never hit (found by CMBT-10);
  3. **monsters compose to `maxLife = 1`**, because archetype stats never reach
     `composeStats`. **This one is M5's** — it is O-67's unclosed half, and it is
     ticket 1 (`ACTR-24`, D-61).

Cause 3 is the one that makes the check meaningless: a room of 1-HP monsters is
cleared by anything. Close it first, then re-run item ⑧ honestly. Causes 1 and 2
need owner decisions on scope — put them in your first report with a
recommendation, do not silently absorb them into an M5 ticket.

**(c) The status line and the gate table are stale.** `PROGRESS.md` ≈L124 still
says "M4 … 2 из 21 тикета принято". The `## Гейты этапов` table (≈L1445) has rows
only for M0 and M1 — M2, M3 and M4's gate results live as prose at the top of the
file. Fix the status line, and add the missing gate rows while you are in there.
The document exists so a fresh session understands the state in one minute.

**Report all of §1.1 in your first message, then keep going.** You do not wait
for an answer to start `ACTR-24` — only D-54 and O-94's causes 1–2 need the
owner, and neither blocks M5's first ticket.

### 1.2 Measured baseline, 2026-08-02

Re-measure it yourself in §14 and put the real numbers in your first report —
this is how you notice later that a ticket quietly deleted somebody's tests.

```
build      → green, 751 ms, one chunk (vite's >500 kB warning is not a gate)
test:unit  → tests 2051  pass 2051  fail 0   (~13 s)
test:perf  → tests  156  pass  156  fail 0   (~276 s, --test-concurrency=1)
lint       → check-imports PASS, 18 roots, 96 files
             check-fixed   PASS, 134 Fixed=N contracts (25 tables, 430 rows),
                           118 files, 10 fixedUpdate bodies
balance    → node tools/balance.mjs --skills → RESULT: PASS
             400 pass · 0 fail · 7 warn · 28 notes · 38 skip
shots      → 9 registered, 4 blessed (boot_clean, ui_clean, inventory_full,
             skill_tree_ravager)
```

Budget for that perf stage. Nearly five minutes per acceptance × 18 tickets ×
the reruns a perf-sensitive ticket needs is real time; plan around it rather than
skipping it. M5 adds two sweeps of its own that are slower still — `mapgen.mjs`
runs 5 400 layouts and `balance.mjs --monsters` walks the whole bestiary.

### 1.3 What exists today

- `src/core/` — engine (60 Hz fixed step, `time.step`), registry, allocation-free
  event bus, `rng.js` (xoshiro128\*\* + `fork`/`weighted`), config, input, prewarm
- `src/render/`, `src/physics/` — as at the end of M1
- `src/world/` — **four files only**: `index.js` (WRLD-1/3: `ZoneSystem` shell,
  the four `ZoneDescriptor`s loaded, a minimal `enterZone` proving the emission
  order), `raster.js` (WRLD-2: headless nav rasteriser, N1–N10 as pure
  functions), `testmap.js` (WRLD-3: a hand-authored layout, not a generator),
  `data/zones.js` (all four descriptors). **No `gen/`, no `build/`.**
- `src/nav/` — `index.js`, `grid.js`, `astar.js`, `smooth.js`, `flow.js`,
  `snap.js`, plus M4's `markHazard` (NAV-6, D-58). Complete for M5's purposes
- `src/actors/`, `src/combat/`, `src/items/`, `src/save/`, `src/player/`,
  `src/skills/`, `src/ui/` — as at the end of M4
- `src/ai/` — **three files only**: `index.js` (AI-2 shell — `archetype`,
  `spawnOne`, `brainOf`, `setTarget`, `aliveCount`, `activeCount`),
  `brains/melee.js` (`bone_ranker`'s FSM subset only; its header disclaims
  `maulsmith` explicitly), `data/bestiary.js` (AI-1 — all seven
  `MonsterArchetype` records, frozen)
- `tools/` — `check-imports.mjs`, `check-fixed.mjs`, `capture.mjs`,
  `imagediff.mjs`, `rigcheck.mjs`, `lootsim.mjs`, `iconbench.mjs`, `balance.mjs`
- **`src/materials/`, `src/fx/`, `src/sky/`, `src/audio/` do not exist.** M5
  creates the first one. `tools/mapgen.mjs` does not exist. `src/ui/minimap.js`
  does not exist

`npm test` is `test:unit && test:perf`. Since D-11 a new test file lands in the
perf stage **by name**: anything matching `*.perf.test.js` is picked up by
`test:perf` and excluded from `test:unit`. When you brief a ticket whose tests
assert a time, an allocation or a frame, tell it to name the file
`<thing>.perf.test.js`. You do not edit `package.json`.

The owner has given the go-ahead for M5. The stop-rule in `PROGRESS.md` is
satisfied by this message.

## 2. Read this first — and only this

`docs/` holds ~37 000 lines of specification. Reading it all is the failure mode,
not the diligent path. Your core engineering job is to hand each subagent exactly
the slice it needs.

Read now, in full:

| File | Lines | Why |
|---|---:|---|
| `docs/ARCHITECTURE.md` | 283 | the engine contract. **Every** subagent gets this verbatim, no exceptions |
| `docs/PROGRESS.md` — the header block, the O-table, the M4 findings (O-84…O-94) and D-49…D-59 | ~450 | five milestones of traps, priced in blood |
| `docs/BACKLOG.md` — "How to read a ticket", "Scheduling", the **M5** table (L213–236) | ~60 | 17 of the 18 tickets you are executing — `ACTR-24` is not in it, see §3.2 |
| `docs/spec/07-world-gen.md` §1 (L41–284), §7 (L1661–1834), §12 (L2541–2570) | ~500 | the coordinate/RNG-stream contract, the I1–I9 invariants you must turn green, and the build order |
| `docs/spec/06-monsters-ai.md` §1 (L56–121), §12 (L2750–2846), §13 (L2847–2879) | ~200 | the identifiers, the MB1–MB20 assertions, the build order |
| `docs/spec/12-testing.md` §5.5 (L391–402), §7 (L466–476), §9.1 (L531–544), §11 (L612–636) | ~90 | the gate you must turn green |

Everything else — `docs/spec/01`…`13` — you read **pointwise**, only the sections
a specific ticket names. Do not load a whole spec "to get oriented".
`05-skills.md` (4146 lines) is M4's document and is not M5's business; if you
find yourself reading it, you have drifted.

You will end up having read most of `06` and `07` *in slices*. That is fine and
it is not the same thing as putting 6 000 lines into one brief.

**Two notational traps, read before you slice anything.**

First — and this is M4's D-45 repeating in two documents at once —
**`07 §12.n` and `06 §13.n` are rows of a single table, not markdown
subsections.** `07` §12 is one table at L2547–2560; `06` §13 is one table at
L2852–2865. `grep -n "### 12\.4"` finds nothing. Every M5 backlog row cites the
*row*, which is one summarising clause; the algorithm it summarises lives in a
real section the backlog never names. Quote the row **and** hand over the real
section — §3.5 maps both. See **D-62**.

Second, ids are written bare inside their owning document and prefixed from
outside, exactly as `12` §3 requires: `I1`…`I9` = `07.I01`…`07.I09`,
`MB1`…`MB20` = `06.MB01`…`06.MB20`. Say both spellings in any brief that cites
one. And beware two genuine collisions: `07` reuses **`G1`–`G6`** for the Altar's
fight-space guarantees (§5.3, L1318–1415) and **`G1`–`G9`** for prop instancing
groups (§9.2, L2093–2101) — a bare grep for `G1` hits both. `12-testing.md`
itself is stale on `06`'s ids (see D-63).

## 3. The M5 work list

**18 tickets:** `WRLD-4`…`WRLD-10`, `AI-3`…`AI-9`, `MATL-1`, `TEST-9`, `UI-11`,
and **`ACTR-24`** — a micro-ticket created by D-61 to give O-94's third cause an
owner. The backlog says 17; it predates that decision.

`BACKLOG.md` §Scheduling permits `WRLD ‖ AI ‖ ITEM ‖ SKIL ‖ UI` for M5–M7. There
is no `ITEM` or `SKIL` work in M5, so the real permission is **one world lane,
one AI lane and one UI/materials lane**. §3.4 states the conditions, and they are
tighter than the backlog's blessing suggests.

### 3.1 What was cleared before you started

Thirteen divergences were investigated before this session. All are binding; §4.2
carries the reasoning you need to put in a brief.

| Ruling | What it settles | Binds |
|---|---|---|
| **D-60** | M4's residue is your phase 0: nine journal rows to reconstruct, the status line and gate table to repair, D-54 to escalate | before ticket 1 |
| **D-61** | Monster archetype stats never reach `composeStats` → micro-ticket **`ACTR-24`**, first in the order; closes O-67's second half and unblocks M4's gate item ⑧ | ACTR-24, AI-3, AI-6 |
| **D-62** | `07 §12.n` and `06 §13.n` are **table rows**, not subsections; the algorithm lives in a section the backlog never cites | all |
| **D-63** | AI-6's `06.S05`–`06.S17` **do not exist as assertions** — `S1`…`S17` are FSM transition rows. The real criterion is **MB2 over all six archetypes plus MB19** | AI-6 |
| **D-64** | AI-8's `06.MB01`–`06.MB10` is over-broad → **MB3, MB4, MB7, MB8, MB10**. AI-4's real gates are **MB12, MB13**; AI-7's are **MB11, MB17, MB20, MB9** | AI-4, AI-7, AI-8 |
| **D-65** | Where the backlog's Files column and `07` §12's paths disagree, **the backlog wins** — the precedent is already recorded in `src/world/raster.js`'s own header. Four consolidations, kept and recorded | WRLD-6…WRLD-9 |
| **D-66** | WRLD-4 owns the `requestZone` latch; the partial `enterZone` already in `src/world/index.js` is extended, never duplicated | WRLD-4 |
| **D-67** | WRLD-8's "G1–G3 hold" is a category error — those are boss-fight guarantees owned by AI-10 in M6. WRLD-8's acceptance is **I5, I7 and the bisector walk** | WRLD-8 |
| **D-68** | **5 400 layouts**, not `IMPLEMENTATION_PLAN.md`'s stale "200/200". And `12:394` misroutes I1–I9 to `07` §11 — they are in **§7.1** | TEST-9 |
| **D-69** | The M5 gate needs three baseline shots that **no backlog row owns**: `wastes_seed_a`/`wastes_seed_b` → WRLD-6, `bonereach_hall` → WRLD-7, `dense_combat` → AI-7 | WRLD-6, WRLD-7, AI-7 |
| **D-70** | `balance.mjs --monsters` is in the gate and has no owner → **TEST-9**, as a second named micro-scope, scheduled after AI-8 | TEST-9 |
| **D-71** | `nav.debugTexture` is **unimplementable as contracted** — it returns a `THREE.DataTexture` from a headless lint root. UI-11 bakes on the `ui` side; the contract row is deferred and recorded, not faked | UI-11 |
| **D-72** | `src/materials/` is renderer-side and is **not** a headless lint root; its `data/` subdirectory is auto-discovered and must stay headless. `src/world/gen/` needs no new root — it inherits `src/world`'s full sweep the moment it exists | MATL-1, all WRLD |

Your job with these is to **verify, not re-litigate**: confirm each still matches
the current files, then brief from them. If one turns out not to match reality,
that is a finding worth a message — but the default is that they hold.

### 3.2 The tickets

Files below are the **corrected** paths (§4.2 D-65). Numbering is execution
order, not backlog order.

| # | ID | Title | Files | Deps | Spec | Done when (corrected) |
|---:|---|---|---|---|---|---|
| 1 | **ACTR-24** | **Monster archetype stats reach `composeStats`** (new, per D-61) | `src/actors/stats.js` | ACTR-21 ✅, AI-1 ✅ | 06 §2 (L154–638), 01 §2.3 (L421–448), 03 §9.1 | a `bone_ranker` spawned through `ai.spawnOne` composes real `maxLife`, `minDamage`/`maxDamage`, `defense` and `attackRating` from its archetype record and mlvl scaling — **never `maxLife = 1`**; one archetype at three mlvls reproduces `06` §2's printed columns to the integer; **M4's gate item ⑧ is re-run and each class clears a room of real monsters**. O-67 closes; O-94 cause 3 closes |
| 2 | MATL-1 | GPU texture forge, surface palette | `src/materials/index.js`, `src/materials/forge.js`, `src/main.js` (two lines, O-12) | RNDR-1 ✅ | plan §1, **02 §2 (L157–212)** | stone / dirt / grass / ash / bone; triplanar projection and edge wear present; `paletteFor` and `rarityColour` honour their `Fixed=Y` rows; `prewarmMaterials` compiles at boot and `render.stats.programs` does **not** rise during a 90 s traverse afterwards; **not added as a headless lint root** (D-72), and any `data/` it creates is headless |
| 3 | WRLD-4 | `enterZone` skeleton, event contract | `src/world/zone.js`, `src/world/index.js` (**granted — wiring and `static deps` only**) | WRLD-3 ✅, MATL-1 | **07 §12 row 4 (L2552)** + **§10.2 T1–T15 (L2297–2325)** | `requestZone` latches and the engine services it **between `lateUpdate` and `render`**; emission order **T5 → T8 → T9 → T12** asserted by a subscriber, with `navVersion` identity across `nav:rebuilt` and `zone:ready`; entering town twice yields **byte-identical `NavGrid.flags`** (FNV-1a hash); `src/world/index.js`'s `static deps` becomes `['materials','physics']` (**O-61's world half**). Extends the existing skeleton, never duplicates it (D-66) |
| 4 | WRLD-5 | Ridgewalk layout, pure function | `src/world/gen/ridgewalk.js` | WRLD-1 ✅ | **07 §3 (L594–927)**, esp. R1–R7 + R10; §12 row 5 (L2553); §1.8 RNG streams (L247–284) | runs in Node with **no `three`**; same seed → identical cell arrays; over **200 seeds**: every spine connects the entry row to the exit row, `\|connected\| ∈ [9,14]` on **100 %**, L-path fallback **< 0.1 %**. Draws from stream **S0** for macro and **S1** for shape — never `ctx.rng` directly |
| 5 | WRLD-6 | Ashen Wastes geometry and dressing | `src/world/gen/wastes.js` (D-65), `src/dev/shots.js` (**granted, two shots**) | WRLD-5, MATL-1 | **07 §3.2 R8–R9 (L775–831)**, §3.4 (L908–927), **§9.1–§9.2 (L2084–2178)**; §12 row 6 | 96 × 96 m, 4 × 4 cells, **nine** instancing groups; **draw calls ≤ 27**, **triangles ≤ 320 000** per `render.stats`; prop count within **5 %** of `propBudget`; I9 holds (the world edge is never visible). **Registers, captures, eyeballs and blesses `wastes_seed_a` and `wastes_seed_b`** (D-69) |
| 6 | WRLD-7 | Bonereach BSP generator | `src/world/gen/bonereach.js` (D-65 — one file, spec splits it in two), `src/dev/shots.js` | WRLD-5 | **07 §4 (L928–1222)**, B1–B10 + the worked example; §12 row 9 | over **600 layouts**: `\|rooms\| === targetRooms ∈ [12,18]` on 100 %, `regionCount === 1` on 100 %, every corridor **≥ 3.0 m** at its narrowest nav cross-section; **I1–I4, I6, I8 pass**; dead ends carry loot; entry rooms deny spawns. **Blesses `bonereach_hall`** (D-69) |
| 7 | WRLD-9 | Spawn points and pack descriptors | `src/world/spawn.js` (D-65) | WRLD-6 | **07 §8 (L1835–2081)** + §12 row 8; **13 §1.2 `OPENING_RAMP` (L151–194)**; **03 §10.2** for `DIFFICULTY_MLVL_OFFSET` | **I4 on 600/600 with density inside ±2 %** (tighter than I4's own ±20 %); **exactly one unique per layout on 600/600**; every dead-end tip holds a champion or the unique; step 3b assigns `p.mlvl` from `OPENING_RAMP` **imported from `src/player/data/progression.js`, never redefined**, or from the tier formula whose authority is `03` §10.2 (**+0 / +12 / +22**, not `07`'s stale +0/+9/+17); MB17's `SPAWN_PUSHED === 0` |
| 8 | WRLD-8 | Altar arena, fixed layout | `src/world/gen/altar.js` (D-65) | WRLD-6 | **07 §5 (L1223–1442)** + §12 row 10 | **I5 and I7 on 600/600** — blocked cells inside r = 16 m = **114 ± 6**; the fixed anchor tables (8 summon, 12 teleport, 6 pillar bisectors) are transcribed, not derived; a scripted **4.2 m/s** agent from r = 3.0 opposite a gap reaches the gap on **all six bisectors with ≥ 1.5 s margin, every time**; the `altar_tablet` interactable is present and inert. **Not "G1–G3 hold"** — those belong to AI-10 in M6 (D-67) |
| 9 | WRLD-10 | Transitions, retention, town portal | `src/world/transition.js` (D-65) | WRLD-4 | **07 §10 (L2275–2433)**, T1–T15 + §10.1/§10.3 for the envelope; §12 row 11 | the **350 / 600 / 350 ms** envelope, total **≤ 1100 ms** per leg and a black window **≤ 600 ms**, measured over ten round trips; a retained instance is recognised by **`(zoneId, seed)`**; ground items and chest flags survive a portal round trip; a cleared pack does not respawn; `openPortal` / `closePortal` / `portalAt` land with their `02` rows |
| 10 | AI-3 | Perception and aggro clouds | `src/ai/perception.js` | AI-2 ✅, **ACTR-24** | **06 §4 (L925–1109)** + §13 row 3 (L2856) | **MB16**: nav-raycast versus physics line-of-sight disagree on **< 1.5 %** of sampled pairs over **200 seeds**; a hand-placed six-Ranker pack wakes as a **ripple within 0.50 s** from one trigger and **`ai:pack-alert` fires once**; the pack leashes home when the player runs 34 m; `blindFactor` and the noise ring behave as §4.3/§4.5 state |
| 11 | AI-4 | Nav integration and the A\* budget | `src/ai/nav.js` | AI-3, NAV-4 ✅ | **06 §9 (L2303–2461)** + §13 row 4 | **MB12** — `nav.stats.refusals / (refusals + solved)` **< 0.02** over a 600 s simulation — and **MB13** — `ai` `fixedUpdate` **p95 < 0.30 ms at 25 monsters** (D-64); above **40 actives** every agent is on the field, not queued; `flowVersion` invalidates a cached distance; `nav:rebuilt` invalidation is spread by `i % 45` |
| 12 | AI-5 | Crowd: ring slots, lanes, doorways | `src/ai/crowd.js` | AI-4, PHYS-4 ✅ | **06 §8 (L2144–2300)** + §13 row 5 | a **12-pack in a 3.0 m corridor presents 3 abreast and never single-files**; the same pack in the open arrives on **16 slots from three bearings**; doorway yielding uses `NAV_FLAG.doorway`'s halved separation weight; rank rotation happens |
| 13 | AI-6 | The remaining five archetypes | `src/ai/brains/swarm.js`, `archer.js`, `shaman.js`, `maulsmith.js`, `crawler.js` (five files — one mechanic each) | AI-5 | **06 §2.2–§2.6 (L227–638)**, **§3.4–§3.8 (L831–923)** + §13 row 6 | **MB2 passes for all six archetypes** and **MB19** — maulsmith wind-up never **< 0.90 s**, crawler fuse never **< 0.85 s**, at any IAS the affix and tier tables can produce — plus **MB18** (every archetype's `hitTick` at IAS 0 matches §2's tick columns exactly). **`06.S05`–`06.S17` do not exist; do not chase them** (D-63) |
| 14 | AI-7 | Pack templates and the spawn pass | `src/ai/spawn.js`, `src/dev/shots.js` (**granted, one shot**) | AI-6, WRLD-9 | **06 §5.1–§5.6 (L1114–1308)**, **§10.1–§10.5 (L2466–2582)** + §13 row 7 | **MB11** (every template resolves to exactly `count` members at counts 5–12), **MB17**, **MB20** (every `archetypeId` in a template is in that zone's `ZoneDescriptor.bestiary`), **MB9** (stand-still survival ≥ 3.0 s), and density inside **I4's ±20 %** (D-64); `packTemplate` returns **frozen** records; `mapgen` reports composition headlessly. **Blesses `dense_combat`** (D-69) |
| 15 | AI-8 | Champions, uniques, the nine affixes | `src/ai/rank.js` | AI-7 | **06 §5.7–§5.8 (L1309–1373)**, **§6 (L1376–1598)** + §13 row 8 | **MB3** (champion TTK 8.0–13.0 s at mlvl 10, no affix), **MB4** (unique 17.0–26.0 s), **MB7** (no single affix > 3.5×; no legal 3-affix unique combo > 2.5×), **MB8** (no legal combination is infinite), **MB10** (`ai.rollAffixes` over 100 000 draws matches weights and exclusions within **±1.5 %**, zero violations) — **and only those five** (D-64); ×4.0 life / ×1.6 damage for champions; immunity is tier-gated; a minion inherits the unique's affixes |
| 16 | AI-9 | Corpses and resurrection | `src/ai/corpse.js` | AI-8, ACTR-1 ✅ | **06 §10.6–§10.8 (L2583–2645)** + §13 row 9 | `actors.resurrectableCorpses` sorts by **distance then id**; a Shaman raises **exactly one** Ranker per zone visit; a stun **before** `hitTick` refunds the credit and a stun **after** does not; **no corpse is ever raised twice**; killing the Shaman strips `haste_dust`; the raised actor gets a **fresh** brain and the pack accounting stays consistent |
| 17 | TEST-9 | `tools/mapgen.mjs` **and `balance.mjs --monsters`** | `tools/mapgen.mjs` (**lead-owned — grant explicitly**), `tools/balance.mjs` (**second micro-scope, D-70**) | WRLD-9, WRLD-7, WRLD-8, **AI-8** | **12 §5.5 (L391–402)**, **07 §7 (L1661–1834)**, 12 §7 | **5 400 layouts** — three zones × 200 world seeds × three run indices — with **`07.I01`–`07.I09` green**; **`12.D02`** — two runs at one seed produce identical layout hashes; on a failure it writes the three artefacts per bad seed and the **`cause:` line names the last generator stage that changed the failing quantity**; `--monsters` turns MB1, MB2, MB18 and every MB reachable in M5 green. Follows the **shipped** `lootsim.mjs`/`balance.mjs` CLI, not `12` §5.1's prose (D-48 carries over) |
| 18 | UI-11 | Minimap and ground labels | `src/ui/minimap.js`, `src/ui/index.js` | UI-2 ✅, NAV-1 ✅ | **09 §4.7 (L1011–1058)**, **§9 (L1913–2014)**, §11.2 (L2206–2234), §12.1 (L2317–2387), §13.1 (L2469–2497), §15 U11 (L3086) | **15 items dropped in a 2 m radius produce 15 non-overlapping labels, or 16 plus an overflow chip**; every label is clickable and **the click never also issues a move order** (O-78's shape); the minimap **rebakes exactly once per `nav:rebuilt`**; Alt labels coloured by rarity with the redundant colour-blind channel; `Tab` overlay and `M` corner toggle; ≤ **6** + **48** DOM nodes. **Bakes from `nav.grid`'s typed arrays on the `ui` side — `nav.debugTexture` is deferred** (D-71) |

### 3.3 Order notes you own and should not silently change

- **`ACTR-24` is first and alone.** One file, one composition path — but it is
  the difference between a bestiary and a room of props, and both AI lanes
  measure damage against it. It also closes M4's last red gate item, which is why
  it comes before anything M5 builds. `src/actors/stats.js` is a file four closed
  milestones own: do it once, verify it hard, then never reopen it.
- **`MATL-1` is second and alone**, because it registers a subsystem (O-12's
  two-line permission) and because `WRLD-4`'s `static deps` fix and `WRLD-6`'s
  surfaces both resolve against it. It is also the one M5 ticket that legitimately
  imports `three`, so landing it early makes the lint boundary obvious to
  everyone downstream.
- **`WRLD-4` before every other world ticket.** `07` §12's own note: steps 1–4
  are the critical path. A generator written before the lifecycle exists invents
  its own entry contract and has to be rewritten.
- **`WRLD-5` before `WRLD-6` and `WRLD-7`.** Ridgewalk is the shared layout
  spine; the Wastes dress it and Bonereach reuses its region/connectivity
  machinery. It is also the cheapest ticket to prove — pure functions, no `three`,
  200 seeds in seconds — so a defect there is caught before two build tickets
  inherit it.
- **`WRLD-9` before `WRLD-8`,** despite the backlog's ordering. Spawning is what
  `AI-7` waits on and what `TEST-9`'s I4 needs; the Altar has no dependants inside
  M5 and its boss guarantees are M6's. Do not let the arena's fixed anchor tables
  block the AI lane for a day.
- **The AI lane is strictly sequential and there is no shortcut.** `AI-3` →
  `AI-4` → `AI-5` → `AI-6` → `AI-7` → `AI-8` → `AI-9`, each one reading the last.
  `06` §13's own dependency note allows steps 6/7 to overlap with 8; **do not take
  that permission** — `AI-6` writes five brains, `AI-7` spawns them and `AI-8`
  promotes them, and a promotion bug on top of an unfinished brain is two days you
  will not get back.
- **`AI-7` waits for `WRLD-9`.** It resolves templates against spawn points that
  do not exist until the world lane produces them. Starting it early produces a
  ticket that mocks the thing it exists to consume.
- **`TEST-9` last, and after `AI-8`.** It is the instrument that reads the whole
  world and the whole bestiary; it cannot be written against half of either. Its
  `--monsters` half is a second micro-scope and needs `AI-8`'s ranks and affixes
  to exist.
- **`UI-11` can float.** It is the only UI ticket in M5, so `src/ui/index.js` is
  never contended. Schedule it whenever a lane frees up — but not before
  `WRLD-4`, because the minimap rebake keys on `nav:rebuilt` and you want a real
  zone change to test against.

### 3.4 Parallelism — the permission and its conditions

Three lanes at most — world, AI, and one floating UI/materials lane. Before you
launch two subagents at once, all five must hold:

1. **Disjoint owned files.** Compare the Files columns literally, not by prefix.
   The backlog's Files columns are known to be incomplete — ask each agent to
   declare any additional file it needs *before* it writes, and treat the
   declaration as the real disjointness check.
2. **Only one agent may hold `src/world/index.js` at a time.** `WRLD-4` holds it
   for the whole ticket. Nothing else in the world lane may open it; if a later
   world ticket needs a line there, it reports the line and **you** write it.
3. **Only one agent may hold `src/dev/shots.js` at a time** — `WRLD-6`, `WRLD-7`
   and `AI-7` all register shots into it. Serialise, or you will merge three
   conflicting registrations by hand.
4. **Only one agent may hold `docs/spec/02-api-contracts.md` at a time.** M5 adds
   a great deal of surface: `world` alone contributes `requestZone`, `current`,
   `bounds`, `groundHeight`, `surfaceAt`, `entry`, `spawnPoints`, `packs`,
   `lightAnchors`, `openPortal`/`closePortal`/`portalAt`, `interactableAt`,
   `openChest`, `isTown`; `ai` adds `spawnPack`, `despawnAll`, `alertPack`,
   `rollAffixes`, `affixStats`, `packTemplate`, `priorityTargets`,
   `setDensityBudget`; `materials` is an entire new table; `ui` adds
   `setMinimapOpen`, `minimapMarker`, `clearMinimapMarker`. Have the second agent
   report the row and write it yourself.
5. **Only one agent may hold `src/main.js` at a time.** M5 registers exactly one
   new subsystem — `materials` (MATL-1). O-12's two-line permission, granted by
   name.

**And verify serially.** Two agents may be *writing* at once; you run `npm test`
against one landed change at a time. A green suite containing two unverified
tickets tells you nothing about either. M1 measured what concurrency does to the
perf stage — the same test failed ~1 run in 9 idle and 2 in 4 with one subagent
running alongside. **Do not run the acceptance suite while a subagent works.**
M5 makes this worse, not better: `mapgen.mjs`'s 5 400 layouts and MB13's p95
budget are both wall-clock sensitive.

### 3.5 Spec slices

Verify each heading with `grep -n` before slicing — line numbers drift, headings
are authoritative. Remember D-62: for `07 §12.n` and `06 §13.n` you want the
**row**, and then the real section it summarises.

```bash
# 07-world-gen.md — the world half of this milestone (2683 lines)
#   §1 conventions L41-284  (1.2 lattices L59, 1.3 height L87, 1.5 occlusion plane L171,
#     1.7 Footprint L220, 1.8 RNG STREAMS S0-S6 L247-284)
#   §2 Last Bastion L285-593        (hand-authored town — M6's business, not M5's)
#   §3 ASHEN WASTES / RIDGEWALK L594-927
#     (3.2 algorithm L633-866: R1 endpoints L637, R2 spine L653, R3 branches L682,
#      R4 connected set L703, R5 terraces L709, R6 gates L724, R7 archetypes L745,
#      R8 dressing L775, R9 boundary L812, R10 entries/chests L832, R11 spawns L854;
#      3.3 worked example L867-907; 3.4 instancing cost L908-927)
#   §4 BONEREACH / BSP L928-1222
#     (4.2 algorithm L972-1178: B1 room target L974, B2 BSP L980, B3 rooms L1010,
#      B4 corridors L1043, B5 loops L1081, B6 doorways L1100, B7 roles L1118,
#      B8 chests L1135, B9 dressing L1147, B10 entries L1165; 4.3 example L1179)
#   §5 ALTAR L1223-1442 (5.2 plan L1259, 5.3 G1-G6 fight space L1313-1415,
#      5.4 entrance/seed L1416)
#   §6 the nav grid L1443-1660 (6.2 N1-N11 L1463, 6.3 rasterisation L1486,
#      6.5 build cost L1551, 6.7 VERSIONING L1634)
#   §7 GUARANTEES L1661-1834 (7.1 I1-I9 TABLE L1669-1679, 7.2 the sweep L1689,
#      7.4 pinned fixture seeds L1750, 7.5 failure output L1770)
#   §8 SPAWNING L1835-2081 (8.1 derived budget L1843, 8.2 density L1885,
#      8.3 placement + step 3b L1924, 8.4 champion/unique L1988, 8.5 safety radius L2000,
#      8.6 zone level and tier L2027)
#   §9 props L2082-2274 (9.1 instancing groups L2084, 9.2 catalogue G1-G9 L2106)
#   §10 TRANSITIONS L2275-2433 (10.1 loading policy L2277, 10.2 T1-T15 L2297,
#      10.3 time budget L2326, 10.4 what is preserved L2364, 10.5 town portal L2401)
#   §11 lighting anchors L2434-2540
#   §12 IMPLEMENTATION ORDER L2541-2570 (rows, not subsections — D-62)
#   §13 additions folded into 02-api-contracts.md L2571-2683
awk '/^## 12\. Implementation order/,/^## 13\./' docs/spec/07-world-gen.md

# 06-monsters-ai.md — the bestiary half (3313 lines)
#   §1 identifiers L56-121   §2 DATASHEETS L122-714
#     (2.1 bone_ranker L154, 2.2 carrion_swarm L227, 2.3 ashen_archer L290,
#      2.4 dust_shaman L365, 2.5 maulsmith L453, 2.6 blight_crawler L541,
#      2.7 vs three reference builds L639)
#   §3 brains L717-922 (3.3 SHARED FSM + S1-S17 TRANSITION ROWS L765-830,
#      3.4 melee overrides L831, 3.5 archer kiting L847, 3.6 shaman priority L869,
#      3.7 swarm surround L891, 3.8 crawler fuse L904)
#   §4 PERCEPTION L925-1109 (4.1 table L925, 4.2 the test L945, 4.3 blinding L983,
#      4.4 leash L1000, 4.5 noise L1023, 4.6 PACK PROPAGATION L1057, 4.7 threat L1094)
#   §5 packs L1114-1373 (5.1 mixed packs L1114, 5.2 resolution L1136,
#      5.3 wastes templates L1167, 5.4 bonereach L1207, 5.5 altar L1242,
#      5.6 incoming damage L1258, 5.7 PROMOTION L1309, 5.8 unique names L1343)
#   §6 THE NINE AFFIXES L1376-1598 (6.1 the nine L1376, 6.2 mechanics L1395,
#      6.3 eligibility L1409, 6.4 immunity tier gate L1429, 6.5 danger budget L1463,
#      6.6 cost to player L1514, 6.7 telegraphs L1565)
#   §7 Molgrim L1601-2141   (M6's, not M5's — do not read it)
#   §8 CROWD L2144-2300 (8.2 ring slots L2158, 8.3 local avoidance L2192,
#      8.4 formations L2226, 8.5 THE CORRIDOR PROBLEM L2247)
#   §9 NAV BUDGET L2303-2461 (9.1 budget L2303, 9.2 ring scheduler L2327,
#      9.3 flow vs A* L2366, 9.4 invalidation L2394, 9.5 measured cost L2426)
#   §10 spawn/corpses L2466-2645 (10.1 spawn pass L2466, 10.2 entrance safety L2496,
#      10.3 activation L2520, 10.4 LOD L2552, 10.5 despawn L2569,
#      10.6 CORPSES L2583, 10.7 RESURRECTION L2598, 10.8 what ai must never do L2633)
#   §11 difficulty tiers L2655-2747   (M7's)
#   §12 VALIDATION L2750-2846 (12.2 MB1-MB20 L2763-2788, 12.3 failure format L2789)
#   §13 IMPLEMENTATION ORDER L2847-2879 (rows, not subsections — D-62)
#   §14 RNG draw order L2882-2943   §15 disagreements L2944-3101
#   §16 additions to 02-api-contracts.md L3102-3219
awk '/^## 13\. Implementation order/,/^## 14\./' docs/spec/06-monsters-ai.md

# 01-data-model.md: MonsterArchetype L421-448 (ACTR-24), §9 world/zones/nav L1323-1500
#           (ZoneDescriptor L1325, ZoneInstance L1364, NavGrid + NAV_FLAG L1395-1433,
#            SpawnPoint L1435, PackDescriptor L1449, Brain L1473),
#           §11 object pools L1683-1759 (Brain L1696, Corpse L1703, PathRequest L1706)
# 02-api-contracts.md: materials §2 L157-212, world §5 L363-456, nav §6 L458-529
#           (debugTexture L505 — deferred, D-71), ai §12 L1059-1137,
#           ui minimap L1301-1303
# 03-combat-math.md: §9.1 aggro/leash radii, §9.3 champion/unique affix counts,
#           §9.4 affix effects, §10.2 DIFFICULTY_MLVL_OFFSET (+0/+12/+22 — authoritative)
# 09-ui.md: §4.7 minimap L1011-1058, §9 ground labels L1913-2014,
#           §11.2 keybinds L2206-2234, §12.1 rarity colours L2317-2387,
#           §13.1 DOM budget L2469-2497 (minimap 6, labels 48), §15 U11 L3086
# 13-progression-lore.md: §1.2 OPENING_RAMP L151-194 (literal at L169-177),
#           §1.7 zone tier table L329-348
# 12-testing.md: §5.5 mapgen L391-402, §7 determinism L466-476 (12.D02 L469),
#           §9.1 the shot set L531-544, §11 milestone gates L612-636 (M5 row L625)
```

## 4. Standing constraints carried into M5

Each was paid for in M0–M4 and is recorded in `PROGRESS.md`. Put the relevant
ones **into the brief of the ticket they bind**, by name.

### 4.1 Performance rules found by measurement (all tickets)

- `Math.hypot` allocates — 5.73 B/call vs 0.34 B for `Math.sqrt(x*x + y*y)`.
  Banned in anything marked `Alloc = no`. **M5 is full of distance work** — ring
  slots, aggro radii, spawn spacing, label declutter — and this is the single
  most likely place to lose it.
- `Map` leaks on never-repeating keys (~456 B/call) even when live entries stay
  at one, and **`Map.prototype.clear()` allocates unconditionally, even on an
  empty map.** The house idiom is now the **generation stamp**: a flat typed array
  keyed by slot index, holding `generation × 2³² + value`, where a generation
  mismatch means "absent". It was invented for `actor.cooldowns` (SKIL-2), reused
  for rage credit (CMBT-8/D-57) and buff slots (SKIL-13). `Brain`, `PackDescriptor`
  and corpse records are all pooled and recycled — **use the idiom, do not invent
  a fourth variant.**
- `array.length = 0` tears the backing store; the next write reallocates.
- Template strings in a hot path allocate — O-59 caught `buildAttackPacket`
  building ten per call. Archetype and template dispatch keyed on a string id is
  exactly that shape; key on an integer index resolved once in `init()`.
- **A time-based criterion hides an abort.** M1's most expensive lesson: NAV-2
  met "≤ 1 ms" by refusing to work. Wherever a criterion measures time, pair it
  with a criterion on **work actually done**. In M5 this binds **AI-4** most of
  all — MB13's "p95 < 0.30 ms at 25 monsters" is trivially met by a scheduler that
  services fewer agents, which is exactly why MB12 caps the refusal *ratio* in the
  same breath. Assert both, always together. It binds **TEST-9** the same way:
  prove 5 400 layouts were actually evaluated, not that the run was fast.
- **O-43/O-23: allocation probes need N ≥ 1 000 000.** On correct,
  allocation-free code the mean decays 80.45 → 17.88 → 0.391 → 0.325 B/call as N
  goes 10k → 100k → 1M → 4M. Fix by lengthening the warm-up, never by loosening
  the threshold; distinguish a real leak by watching **total** bytes, not the
  mean. `12.A02` — a full `fixedUpdate` step with 25 monsters under 1 byte — is
  the M5 probe most at risk, and AI-4/AI-5/AI-6 all write into that path.
- **O-85: an allocation assert in the unit stage flakes under concurrency** and
  passes in isolation. Seen three times in M4. Rule: **never call a red
  allocation probe a regression until you have re-run it alone.** Fix by moving
  the probe into a `*.perf.test.js` file, never by retry, never by loosening.
- **O-93 is the mirror image and is still open**: `tests/ui/target.perf.test.js`
  sits on its threshold and fails about one run in three *in isolation*. If you
  see it, that is the known flake — but measure before you shrug, because the
  distinction between a warm-up decay and a real ~2 B/call leak in
  `UiSystem#lateUpdate` has never been made. **UI-11 opens that file's
  neighbourhood; have it settle the question.**
- **O-79: there is a ~1.14 B/call floor** in the `setSourceLayer` → `stats` path
  inside `actors`, found under ITEM-11 and never explained. **ACTR-24 writes
  through exactly that path.** If your probe lands near 1.1 rather than near 0,
  suspect the inherited floor before the ticket — and this is the first ticket in
  five milestones with a real reason to isolate it. Ask it to.

### 4.2 The rulings — settled, binding, brief from these

Thirteen divergences, **D-60…D-72**, all orchestrator rulings settled by this
prompt. Journal them as D-entries on first contact so M6 does not re-litigate
them. **Verify each against the files before you use it — do not re-open it.**

**⚠ Naming collision, read this first.** `05-skills.md` numbers its own balance
decisions `D-05-1…3` and `09-ui.md` has its own `D-15`; neither is `PROGRESS`'s
`D-n`. Cite as `05 D-05-n` / `09 D-15` versus `PROGRESS D-n`. `07-world-gen.md`
reuses `G1`–`G6` (Altar fight space) and `G1`–`G9` (prop groups) inside one
document.

---

**1. M4's residue is your phase 0. [D-60]**

Nine journal rows are missing, the M4 gate never concluded, and the status line
contradicts the repository. §1.1 states the work. The reason this is a ruling and
not a chore: `PROGRESS.md` is the only artefact that tells a fresh session what
happened, and M4 is the first milestone whose journal disagrees with its own
tree. Left alone it compounds — M6 would read "2 of 21 accepted" and re-plan
work that shipped.

Reconstruct the rows honestly. A row written from evidence, and labelled as such,
is worth far more than a missing one and slightly less than an observed one. Say
which it is.

---

**2. Monsters compose to `maxLife = 1`. Micro-ticket `ACTR-24`. [D-61]**

`O-67` was closed by ACTR-21 for the player/actor-engine half — vessels are
filled on spawn and the state machine leaves `'spawning'`. The monster half was
explicitly deferred: a `MonsterArchetype`'s `baseLife`, `baseMinDamage`,
`baseMaxDamage`, `baseDefense` and `baseAttackRating` (`01`:421–448) never reach
`composeStats`, so every spawned monster composes to a `maxLife` of 1.

M4's orchestrator found this the hard way, running gate item ⑧ with hand-set
30 HP monsters to get a meaningful answer at all (O-94). The consequence is not
subtle: **every TTK number in M5 is measured against monster life.** MB2, MB3,
MB4, MB9 and the whole `--monsters` harness are meaningless until this lands.

**Micro-ticket `ACTR-24`**, one file, first in the order. Precedent and shape:
D-42/ACTR-20 and D-49/ACTR-21 — a named micro-scope in a file owned by closed
milestones, with the same restraint. No new behaviour beyond the composition
path; no signature drift; each touched method's `02` row re-checked for its
`Fixed`/`Alloc` columns. When it lands, **re-run M4's gate item ⑧ yourself** and
record the result under O-94.

---

**3. `07 §12.n` and `06 §13.n` are table rows. [D-62]**

`07` §12 is a single table at L2547–2560; `06` §13 is a single table at
L2852–2865. There are no `### 12.4` or `### 13.7` headings. A brief that says
"implement `07` §12.6" and expects the agent to grep for a heading sends it
hunting for something that does not exist.

Worse than M4's version of this trap: here the row is *also* the only thing the
backlog cites, and the row is one clause. `07` §12 row 9 says "Bonereach" in
eleven words; the B1–B10 algorithm it stands for is 294 lines at L928–1222. Every
M5 world ticket and every M5 AI ticket has this shape. **Quote the row, then hand
the real section.** §3.5 maps both for all eighteen tickets.

---

**4. AI-6's `06.S05`–`06.S17` do not exist. [D-63]**

`BACKLOG.md:227` gives AI-6 the Done-when "`06.S05`–`06.S17` green". `06` §12.2
defines `MB1`…`MB20` (plus `MB5b`) and no `S`-prefixed assertion at all. What
`S1`…`S17` actually are: the rows of the **shared FSM transition table** in §3.3
at L807–823 — `S10` is "attack → attack when the action completes and the target
is still in range", not a check anything can run.

This is the second time. `ORCHESTRATOR_PROMPT_M2.md:252` had to make the identical
correction for AI-2's "`06.S01`–`06.S04`". The likely source is
`12-testing.md:117`, which claims `06` §12 "has `S1…S17`" and at L126 offers the
worked example "`06.S10` the pack-alert propagation check" — that check is
**MB16** (`06`:978, `06`:2856). `12-testing.md`'s own §5.2 at L330 lists only
`06.MB01`–`06.MB20` and silently disagrees with its own earlier text.

**AI-6's criterion is `06` §13 row 6 (L2859): MB2 over all six archetypes, and
MB19's wind-up floors.** Add **MB18** — every archetype's `hitTick` at IAS 0
matching §2's tick columns — because AI-6 is the ticket that can break it.

*Spec edits (whoever reaches them first, not you):* mark `12-testing.md:117` and
its L126 example stale.

---

**5. AI-4, AI-7 and AI-8 have the wrong assertion sets. [D-64]**

`BACKLOG.md:229` gives AI-8 "`06.MB01`–`06.MB10`" as a contiguous range. `06`
§13 row 8 (L2861) names **MB3, MB4, MB7, MB8, MB10** — and the others belong
elsewhere: MB1 is bestiary scaling (row 1, shipped with AI-1 and now really
proved by ACTR-24), MB2 is normal-rank TTK (row 2/row 6), MB5 and MB5b are
Molgrim (row 10, M6), MB6 is the class-TTK spread (row 11, M7). An agent told to
turn MB5 green in M5 will either fake it or stall.

The opposite error in the same table: **AI-4's and AI-7's rows name no assertion
at all**, though the spec does. AI-4's gates are **MB12** and **MB13**; AI-7's are
**MB11, MB17, MB20, MB9** plus I4's ±20 % density band. A subagent briefed only
from the backlog row would not know what it is being measured by.

---

**6. Where the backlog and `07` §12 disagree on a path, the backlog wins — and
the precedent is already in the tree. [D-65]**

`src/world/raster.js`'s own header records this decision verbatim: `07` §12 step
2's prose says `src/nav/raster.js`, the backlog's Files column says
`src/world/raster.js`, and the backlog governs. M5 has four more instances, and
they are all the same shape — the spec splits a ticket across `gen/` and `build/`
files, the backlog consolidates:

| Ticket | Backlog (**wins**) | `07` §12 says |
|---|---|---|
| WRLD-6 | `src/world/gen/wastes.js` | `src/world/build/wastes.js` |
| WRLD-7 | `src/world/gen/bonereach.js` | `src/world/gen/bsp.js` **+** `src/world/build/bonereach.js` |
| WRLD-8 | `src/world/gen/altar.js` | `src/world/gen/arena.js` **+** `src/world/build/altar.js` |
| WRLD-9 | `src/world/spawn.js` | `src/world/gen/spawn.js` |

`WRLD-4` and `WRLD-10` have no spec path at all — `07` §12 rows 4 and 11 name
only methods — so `src/world/zone.js` and `src/world/transition.js` are backlog
inventions, consistent with house style, and **kept**. Record them as invented,
exactly as D-43 and D-28 recorded theirs.

**One caution the consolidation creates:** a `gen/` file that also dresses
geometry is a file that imports `three` inside a headless lint root. It cannot.
Keep the generator pure and put the `three`-side construction where the renderer
already lives, or ask before you write. See D-72.

---

**7. `WRLD-4` extends the existing `enterZone`; it does not fork it. [D-66]**

`src/world/index.js` already implements a partial `enterZone` from WRLD-3 —
enough to prove the emission order `zone:teardown → zone:enter → physics.rebuild
→ nav.rebuild → zone:ready`, with `staticFootprints` frozen at `zone:ready`. Its
header says in as many words that `serviceZoneRequest`/`requestZone` are **not**
implemented there and belong to WRLD-4.

`07` §12 row 4 names no file, and the backlog invents `src/world/zone.js`. Left
unsaid, this produces two lifecycle skeletons that drift within a day. **Ruling:**
`zone.js` owns the `requestZone` latch, the service point between `lateUpdate`
and `render`, and the T5 → T8 → T9 → T12 emission; `index.js` is granted to
WRLD-4 for **wiring and the `static deps` array only** (`['materials','physics']`
— O-61's world half). No second `enterZone`.

---

**8. WRLD-8's "G1–G3 hold" is a category error. [D-67]**

`BACKLOG.md:221` gives WRLD-8 the Done-when "G1–G3 hold". Those are `07` §5.3's
**fight-space guarantees** — the Phase I sweep, the summon ring, the Phase II
fire rings (L1318–1369). They are properties of Molgrim's behaviour, and the
ticket that implements Molgrim is **AI-10, in M6** (`BACKLOG.md:251`). A static
arena generator cannot make them hold; it can only make them *possible*.

`07` §12 row 10 (L2558) states the real acceptance: **I5 and I7 on 600/600**
(the arena intact, blocked cells inside r = 16 m at 114 ± 6) plus **the scripted
4.2 m/s bisector walk** arriving with ≥ 1.5 s margin on all six bisectors. That is
what a geometry ticket can be held to, and it is exactly the thing that makes
G1–G6 achievable later.

Brief WRLD-8 on I5, I7, the anchor tables and the walk. Tell it that G1–G6 exist,
that they are M6's, and that its job is to leave them satisfiable.

---

**9. 5 400 layouts, and I1–I9 live in §7.1. [D-68]**

`IMPLEMENTATION_PLAN.md:611` states M5's criterion as "`mapgen.mjs` — 200/200
сидов связны". `12-testing.md` §5.5 (L391–402) and `BACKLOG.md:232` both say
**5 400 layouts — three zones × 200 world seeds × three run indices**. The plan's
number is a stale simplification and undercounts by 27×. The backlog and `12`
win; the plan is the same class of stale text that D-39 already caught once.

**And `12-testing.md:394` points at the wrong section**: it says the I1–I9
invariants live in `07-world-gen.md` §11. §11 is *Lighting anchors*. They are in
**§7.1, L1663–1688**. TEST-9 cites `12` §5.5, so a subagent following the pointer
lands on lighting and finds no invariants. Hand it the right range.

Note also the two distinct 200-seed concepts: `mapgen.mjs` sweeps 200 **world
seeds** (× 3 zones × 3 run indices = 5 400), while `06` §12's `--sim` re-uses
"the 200 mapgen seeds" as its own simulation set. Same 200, different totals; do
not let a brief conflate them.

---

**10. Three gate shots, and no backlog row owns any of them. [D-69]**

`12-testing.md:625` — the M5 gate — requires `wastes_*`, `bonereach_hall` and
`dense_combat` to **enter the baseline**. `12` §9.1 (L531–544) assigns all four
shot names to M5: `wastes_seed_a`, `wastes_seed_b`, `bonereach_hall`,
`dense_combat`. The backlog's own M5 gate line (L235–236) silently drops them,
and no M5 row mentions a shot at all. Left alone the gate is unsatisfiable by the
tickets as scoped — the identical hole D-40 found in M4.

**Owners, on the UI-1/`ui_clean` precedent:** `WRLD-6` registers, captures,
eyeballs and blesses **`wastes_seed_a` and `wastes_seed_b`** (two seeds of the
same generator is precisely what proves a generator); `WRLD-7` owns
**`bonereach_hall`**; `AI-7` owns **`dense_combat`**, because it is the first
ticket that can put a real pack on screen. Each blesses only after looking at the
PNG, and each writes an honest `description` saying what the frame contains and
what it does not.

---

**11. `balance.mjs --monsters` has no owner either. [D-70]**

The M5 gate requires it (`12`:625). `BACKLOG.md`'s M5 rows give `tools/` work to
TEST-9 alone, and TEST-9's Files column is `tools/mapgen.mjs`. Meanwhile
`tools/balance.mjs` already exits `2` on `--monsters` with a message naming the
milestone that owns it — TEST-8 shipped that behaviour deliberately under D-48.

**Ruling:** `tools/balance.mjs --monsters` is a **second named micro-scope inside
TEST-9**, scheduled after AI-8. Precedent: D-38's `XP_TOTAL` micro-scope inside
PLYR-4 — a named addition to an existing ticket, not a new ticket. The shared
harness already exists; this fills one flag. `--builds` and `--sweep` stay M7's,
`--progression` stays M6's, and they keep exiting `2`.

If `--monsters` turns out to be larger than the harness it plugs into — MB1
through MB20 minus the boss and tier rows is a lot of assertions — **split it out
as `TEST-10` and say so**, rather than letting one ticket quietly become two.

---

**12. `nav.debugTexture` cannot exist as contracted. [D-71]**

`02-api-contracts.md:505` contracts `nav.debugTexture()` returning a
`THREE.DataTexture`, "for the minimap". `tools/check-imports.mjs:650` declares
`src/nav` a lint root with `checkThree: true` — `src/nav/` may not import `three`,
transitively. The contract and the lint are mutually exclusive, and the lint is
the one with five milestones of code behind it.

**UI-11 bakes on the `ui` side**: read `nav.grid`'s typed arrays through the
existing accessors and rasterise into the minimap's own canvas. The contracted
`nav.debugTexture` row is **deferred and recorded**, not faked, not quietly
dropped — D-41's treatment of `ai.debugStage`, applied to a return type instead
of a missing method. Name the owing decision in the journal: either the contract
row is withdrawn or `nav` gains a headless `debugBitmap`-shaped method; that is
an owner call, not yours.

---

**13. `src/materials/` is renderer-side; `src/world/gen/` inherits its root. [D-72]**

`tools/check-imports.mjs` declares twelve roots explicitly and auto-discovers
every `data/` directory (L665–673) — 18 at runtime today. `src/materials/` is not
among them and **must not be added**: a GPU texture forge is renderer-side and
`three` is its whole job, exactly like `src/render/`. What *is* binding: any
`src/materials/data/` directory it creates **is** auto-discovered and must stay
headless.

The inverse trap is `src/world/gen/`. It needs no new root — it is a subdirectory
of the already-declared `src/world` root and inherits the full
`checkThree: true, checkGlobals: true` sweep **the moment it exists**. So a
generator that reaches for `three` to build a mesh fails the lint on the first
run. That is the boundary D-65's consolidation makes easy to trip over: keep
`gen/` pure, and do the construction where `three` is already legal.

The signal to watch: the imports lint's file count rises from **96** as `gen/`
lands. If it does not rise, the directory is not where the lint expects it.

### 4.3 Per-ticket bindings

| Ticket | Must be told |
|---|---|
| ACTR-24 | A composition path is a composition path. No new behaviour, no signature drift, no "while I'm here". `src/actors/stats.js` is owned by four closed milestones — D-42/ACTR-20 and D-49/ACTR-21 are the shape to copy, including their restraint. **O-79's ~1.14 B/call floor lives in this exact path** and you are the first ticket with a reason to isolate it: report what you find either way. Also live here: **O-81** (`_cache.unusable` and `01` §4.4's continuous requirement re-check exist nowhere) — report, do not fix |
| MATL-1 | You may import `three`; you are renderer-side (D-72). Do **not** add `src/materials/` to `check-imports.mjs`; any `data/` you create is auto-discovered and must be headless. O-12 grants exactly two lines in `src/main.js`. `prewarmMaterials` is the contract that makes `render.stats.programs` flat after boot — a forge that compiles lazily passes every unit test and fails the gate's traverse. `paletteFor` and `rarityColour` are `Fixed = Y`: they may not read the wall clock |
| WRLD-4 | D-66 in full: extend, never fork. The service point is **between `lateUpdate` and `render`** — not inside `fixedUpdate`, not at the top of the frame. T5 → T8 → T9 → T12 is asserted by a subscriber that records order, not by reading the code. The byte-identical `NavGrid.flags` check across two entries into town is the determinism proof and it is cheap: FNV-1a over the flags array. `static deps` becomes `['materials','physics']` (O-61) |
| WRLD-5 | Pure functions, no `three`, no DOM, runs under `node --test`. Draw from the **named RNG streams** of `07` §1.8 — S0 macro, S1 shape — via `ctx.rng.fork()`, never `ctx.rng` directly; the stream layout is what makes `12.D02` possible later. The three numeric bars are the ticket: `\|connected\| ∈ [9,14]` on 100 % of 200 seeds, L-path fallback < 0.1 %, identical arrays at one seed. **Print the distribution, not a pass/fail** — a sweep that says "green" without showing counts is not evidence |
| WRLD-6 | Draw calls ≤ 27 and triangles ≤ 320 000 are **measured asserts** off `render.stats`, not advice. Nine instancing groups, from `07` §9.1's table — not eight, not "about nine". Prop count within 5 % of `propBudget`. I9 (the world edge is never visible) is yours and it is a camera-frustum property, not a geometry one. **Two shots, both eyeballed before blessing** (D-69). Keep the generator half pure; the `three` half is renderer-side (D-72) |
| WRLD-7 | B1–B10 in order; the merge-tree corridor construction (B4) is what guarantees connectivity, so `regionCount === 1` is a consequence to assert, not a thing to enforce afterwards by patching. **Every corridor ≥ 3.0 m at its narrowest nav cross-section** — measure in nav cells, not in metres of intent, because AI-5's corridor criterion reads exactly this. Entry rooms deny spawns (B7). **Blesses `bonereach_hall`** |
| WRLD-9 | `OPENING_RAMP` is **imported** from `src/player/data/progression.js` (13 §1.2, literal at L169–177) — PLYR-4 created that file in M4 and duplicating the table is the fabrication D-38 exists to prevent. The tier offsets are **`03` §10.2's +0 / +12 / +22**, not `07` §8.6's own stale +0/+9/+17 — `07`:2054–2058 says so itself. Density inside **±2 %**, which is tighter than I4's own ±20 %: the tight band is what catches a budget that is right on average and wrong per cell |
| WRLD-8 | D-67 in full: **I5 and I7, not G1–G3**. The anchor tables (8 summon, 12 teleport, 6 pillar bisectors) are **transcribed from `07` §5.2, not derived** — a derived anchor set that looks right is the exact failure D-38's incident records. 114 ± 6 blocked cells inside r = 16 m is an integer assert. The bisector walk is a scripted agent at 4.2 m/s, run on all six, every time — not sampled |
| WRLD-10 | The 350 / 600 / 350 ms envelope comes from `07` §10.1 and §10.3, **not** from §12's row, which only states the ≤ 1100 / ≤ 600 outer bounds. Ten round trips, measured. Retention keys on **`(zoneId, seed)`** — a retained instance recognised by object identity works until the first reload. Ground items, chest flags and cleared packs are the three things `07` §10.4 says survive; assert all three, and assert that a cleared pack does **not** come back |
| AI-3 | **MB16 is a comparison of two systems**, not a single measurement: nav-raycast versus physics line-of-sight, < 1.5 % disagreement over 200 seeds. Sample pairs, count both sides, print the mismatch rate. The pack ripple is ≤ 0.50 s and **`ai:pack-alert` fires once** — once per pack, not once per member; this is R1's shape from M4 and it broke twice there. Leash at 34 m returns the pack home, it does not despawn it |
| AI-4 | **MB12 and MB13 together, never apart** (§4.1's rule): p95 < 0.30 ms at 25 monsters *and* refusal ratio < 0.02 over 600 s. A scheduler that meets the budget by servicing fewer agents fails, and NAV-2 is the precedent. Above 40 actives, demotion puts **every** agent on the flow field — nobody is queued out. `nav:rebuilt` invalidation is spread by `i % 45`; a synchronous invalidation of 25 brains in one step is the spike this exists to prevent. `nav.setBudget(4)` is the default and it is `nav`'s number, not yours |
| AI-5 | The corridor criterion is the ticket: **12-pack, 3.0 m corridor, 3 abreast, never single-file** — and it reads WRLD-7's actual corridor widths, so run it against a real Bonereach layout, not a hand-built box. Doorway yielding uses `NAV_FLAG.doorway`'s halved separation weight (`01` §9.3). Sixteen ring slots from three bearings in the open. This is the one M5 ticket with no MB id; that makes your independent probe the only check that exists |
| AI-6 | **Five brains, five files, one mechanic each.** `06.S05`–`06.S17` do not exist (D-63) — your criteria are **MB2 for all six archetypes, MB19's wind-up floors (maulsmith ≥ 0.90 s, crawler ≥ 0.85 s at any IAS), and MB18's `hitTick` columns**. The floors are floors under *every* IAS the affix and tier tables can produce, so prove them at the extreme, not at IAS 0. Do not author a seventh archetype, a new affix or a boss phase — plan §10 forbids new content before M7 |
| AI-7 | MB11, MB17, MB20, MB9 (D-64). **`packTemplate` returns frozen records** — `Object.freeze`, and a test that proves mutation throws. MB17 is `SPAWN_PUSHED === 0`: no spawn point needed correcting, which is a statement about WRLD-9's placement as much as yours. MB20 is a containment check — every `archetypeId` in a template is in that zone's `ZoneDescriptor.bestiary`. Density inside I4's ±20 %. **Blesses `dense_combat`** (D-69) |
| AI-8 | **MB3, MB4, MB7, MB8, MB10 — and only those five** (D-64). MB10 is a distribution check over 100 000 draws at ±1.5 % with **zero** exclusion violations; M3's lootsim is the precedent for how to run and print it. MB8 ("no legal combination is infinite") is a search over the legal combination space, not a spot check. Immunity is tier-gated (`06` §6.4) and a minion inherits the unique's affixes (`06` §5.7). **O-92 is live here**: `actor:despawn` is contracted in `ARCHITECTURE.md` and emitted nowhere — you are the ticket that will notice; report it |
| AI-9 | Sort order is **distance then id** — the id tiebreak is what makes it deterministic, and `12.D04` will read it. The stun rule is asymmetric on purpose: **before `hitTick` refunds the credit, after does not**. No corpse is raised twice — prove it with a counter, not with a flag that could be reset. **O-49 is live here**: status-pool slots leak on despawn unless `clearStatuses` runs before `pool.release`, and corpses are exactly where that bites. Report; do not fix outside your file |
| TEST-9 | `tools/` is lead-owned (`ARCHITECTURE.md:112`) — grant `tools/mapgen.mjs` and the `--monsters` micro-scope explicitly, and say nothing else under `tools/` is in scope. Follow the **shipped** CLI: `=`-form flags (`--seed=0x…`, `--zone=NAME`), `--json` as a boolean switch to stdout, exit `0` pass / `1` assertion failure / `2` argument or unowned flag, a `checks[]` array both renderers read, `NOTE` severity counted and **never** changing the exit code, and a check that cannot run reporting `skip` **loudly** (O-58's precedent). The `cause:` line is not decoration: on a failure, re-run that seed with per-stage instrumentation and name the last generator stage that changed the failing quantity. **Do not narrow the assertion set to make it green** |
| UI-11 | D-71: bake from `nav.grid`'s typed arrays; `nav.debugTexture` is deferred. `09`'s hard rule holds — everything animates by integrating `dt` in `lateUpdate`, **no CSS transitions**, because they make the pixel gate non-deterministic. DOM budgets **6** (minimap) and **48** (labels) are measured asserts; `ui.__nodeCount` already exists. The label test is the 2 m/15-item pile: 15 non-overlapping labels or 16 plus a chip, every one clickable, **and the click never also issues a move order** — `ui.pointerOverUi` exists since UI-10 but `inventory.js` and `hud.js` never got their markers (O-78, half-open). Rebake **once** per `nav:rebuilt`, asserted by counting |
| every ticket | **O-12**: a ticket registering a new subsystem may add exactly two lines to `src/main.js` — its `import` and its `registry.add(...)`. Nothing else. Grant by name (M5: MATL-1) |
| every ticket | **O-27 / O-39**: a test written before a subsystem encodes "nothing exists yet". It has bitten eleven times. Never assert counts of subsystems, bodies, items, skills, zones, archetypes or exact pixels, and never write `typeof x.method === 'undefined'`. Assert the behaviour the test exists for |
| every ticket | A public method exists only if `02-api-contracts.md` lists it, **with its `Fixed` and `Alloc` columns**. Adding one means adding its row in the same ticket, and a contract method must be reachable **as a method on the subsystem the contract names** — O-71 is the M3 precedent, where `items` shipped contract methods as module functions and the contract read as satisfied while the subsystem did not expose them. Not automated: **you** are the check, at acceptance |
| every ticket | Any new method whose contract row says `Alloc = no` must be **added to `12.A01`'s probe list**. O-58 exists because one was excluded from the list instead of fixed |

### 4.4 Open debts entering M5

Assign each to a named M5 ticket in your first report, or tell the owner plainly
it is carried to M6. Do not let them drift.

**Newly live because M5 touches them:**

- **O-67 / O-94 cause 3 — monster stats never composed.** Closed by **ACTR-24**
  (D-61). Verify it actually closes: O-67 was closed "for one half" once already.
- **O-94 causes 1 and 2 — weapon range and projectile aiming.** Neither is M5's
  by ownership: cause 1 is `items` (`11` §3.6's `weaponOf(...).weapon.range`
  exists nowhere), cause 2 is `skills`/`ai` (a collinear monster is never hit).
  Both block a *clean* re-run of M4's gate item ⑧. **Bring them to the owner with
  a recommendation in your first report** — the cheap reading is two micro-tickets
  before ticket 3; the other reading is that ⑧ passes on cause 3 alone and the
  rest is M6's.
- **O-79 — the ~1.14 B/call floor in `setSourceLayer` → `stats`.** Binds
  **ACTR-24**, the first ticket in five milestones with a real reason to isolate it.
- **O-81 — `_cache.unusable` and `01` §4.4's continuous requirement re-check
  exist nowhere.** Binds **ACTR-24** (it opens `stats.js`). Report, do not fix.
- **O-49 — status pool slots leak on despawn** unless `clearStatuses` runs before
  `pool.release`. **AI-9** creates the situation; **AI-7**'s despawn pass is the
  other half. Decide who fixes it or record that it is carried again.
- **O-78 — `ui.pointerOverUi` is half-implemented.** The mechanism landed with
  UI-10; `inventory.js` and `hud.js` never got their markers. **UI-11** is the
  ticket that will trip over it, because a ground-label click that also walks the
  character is exactly the failure. Close the second half or say why not.
- **O-92 — `actor:despawn` is contracted in `ARCHITECTURE.md` and emitted
  nowhere.** **AI-7**/**AI-8** are the first real despawners. Owner was recorded as
  AI-8/M6; M5 can close it.
- **O-93 — `tests/ui/target.perf.test.js` flakes on its threshold.** Assigned to
  UI-9, which never got a journal row. Reassign to **UI-11** and settle it by
  measurement (§4.1).
- **O-61 — `static deps` arrays truncated.** The `ui` half closed in M3, the
  `player` half was PLYR-3/PLYR-4's and is unconfirmed, the `world` half is
  **WRLD-4**'s (`['materials','physics']`). Check all three.
- **O-9 — prewarm hook order.** `11-flows.md` §1.4 and `02`'s init order disagree.
  **MATL-1** implements `prewarmMaterials` and will meet it. It is a documentation
  conflict, not a code one — record the answer.
- **O-89 — `skills` reaches `nav` through `ctx.peek`, not `static deps`.** M5
  registers `materials` and reorders nothing, but AI-4 adds a second `nav`
  consumer. Re-affirm or fix.

**Carried, and still nobody's:**

- **O-40** — `src/physics/separate.js` reads `performance.now()` inside the fixed
  step and `check-fixed.mjs` cannot see it; `src/physics/` stays on
  `checkGlobals: false`. A determinism hole, and M5 is the first milestone whose
  gate is a determinism sweep (`12.D02`). If a layout hash ever differs between
  two runs, **look here before you look at the generator.**
- **O-59** — `buildAttackPacket` builds ten template-string keys per call.
  Contractually `Alloc = pool`, so it blocks no gate, but every monster attack in
  this milestone goes through it, 25 at a time.
- **O-87** — `actors.moveSpeed` ignores `StatBlock.movementSpeed`, which makes
  every slow and every haste cosmetic. **AI-6's `dust_shaman` grants `haste_dust`
  and AI-8's affixes include movement modifiers** — both will look implemented and
  do nothing. Report loudly; it may deserve a micro-ticket.
- **O-88** — `SpawnSpec` has no `flags` field at all, so `untargetable` in transit
  has nowhere to live. **WRLD-10** (transitions) and **AI-7** (spawning) both meet
  it.
- **O-91** — two documents disagree about the movement-acceptance window during
  an action. Needs an owner ruling; not M5-blocking.
- **O-46, O-47, O-52, O-45, O-1** — read their rows; none binds an M5 ticket, and
  each should be re-affirmed as carried or closed.
- **D-54** — `05.B10` is unreachable as written. **Owner ruling, requested in
  your first report.** Until it comes, `balance.mjs` keeps reporting it as a
  `NOTE` and M4's gate item ⑤ stays open.

### 4.5 Tooling traps (yours, when verifying)

- **O-26**: `tools/capture.mjs` does **not** rebuild `dist/`. Always
  `npm run build` first, or you bless a frame from stale code. This bites all
  three M5 shots.
- **O-50 is fixed** — `shot.setup` runs inside the page (ACTR-6). If a new shot
  comes back byte-identical to `boot_clean`, suspect `setup` before the renderer.
- **O-20**: `--test-name-pattern` must come **before** the glob, and the glob must
  be quoted. Flag after glob silently filters nothing.
- **O-28**: `tests/tools/capture.test.js` boots `vite preview` + Playwright at
  file level, so it runs even under a name filter. Target a directory
  (`tests/world/`, `tests/ai/`) when you want a fast, focused run.
- The perf stage is `--test-concurrency=1` and already takes ~276 s. A new file
  joins it by being named `*.perf.test.js`. If a test flakes, the fix is isolation
  or the perf stage — **never** a retry, never a loosened threshold. See O-85 and
  O-93 for the two shapes this takes.
- `tools/check-imports.mjs` **contains embedded null bytes** — plain `grep`
  silently finds nothing in it. Use `grep -a`. This has cost time before.
- **Four shots are blessed: `boot_clean`, `ui_clean`, `inventory_full`,
  `skill_tree_ravager`.** The four `actor_*` shots and `ui_icons` render but have
  no committed fixture; do not treat their output as a baseline. `ui_icons` is
  deliberately never blessed.
- `src/world/gen/` inherits `src/world`'s lint root the moment it exists (D-72).
  The imports lint's **file count rising from 96** is your signal that the
  directory is where the lint expects it.

## 5. The loop, one ticket at a time

For each ticket in the order of §3.2, subject to §3.4's lane rules:

**5.1 Confirm readiness.** Deps closed? Owned files free of any concurrent agent?
If the previous ticket is not accepted, you do not start what depends on it.

**5.2 Build the brief.** Extract only the named spec sections. Target
**1500–4000 lines** of context per ticket. `06` is 3313 lines and `07` is 2683,
and no single ticket needs either whole; if a brief approaches those numbers you
have taken the document instead of the slice. For WRLD-5, WRLD-7 and WRLD-8, the
worked examples (`07` §3.3, §4.3) and the fixed anchor tables go in **verbatim** —
the agent should be reproducing a printed layout, not deriving one. Same for
`06` §2's datasheet columns in AI-6.

**5.3 Spawn one Sonnet 5 subagent.** One ticket, one agent, named after the
ticket:

```
Agent(
  name: "AI-6",
  description: "the remaining five archetypes",
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
  <corrected Files list, plus any explicitly granted extra file>

If you find you need a file that is not listed, stop and say so in your report
before writing it. The backlog's Files columns are known to be incomplete and
another agent may be holding what you want.

Acceptance criterion (the orchestrator will run this, not eyeball it):
  <the corrected Done when — §3.2, not the backlog's row>

## Engine contract — read this first, it is binding

<full text of docs/ARCHITECTURE.md>

## Specification for this ticket

<only the named sections, extracted from docs/spec/*.md. Quote 07 §12's and
06 §13's rows rather than citing them as sections — they are table rows, not
headings — and then include the real algorithm section the row stands for. If
the ticket has a printed layout, datasheet or anchor table as its criterion
(07 §3.3, §4.3, §5.2; 06 §2), paste it verbatim.>

## Project state you must respect

<the relevant rows from §4: performance rules, the ticket's own O-nn / D-n
entries, the resolved file-name and criterion corrections, the main.js two-line
permission if it applies>

## Rules

1. You own only the files listed above. Editing any other file is a defect and
   will be reverted. If you need someone else's file, say so in the report —
   do not edit it.
2. No new dependencies. `three` only, and gameplay/math code must not import it
   at all. `src/world/`, `src/nav/` and `src/ai/` are headless lint roots: no
   `three`, no `document`, no `window`, no `performance.now()`, transitively —
   and `src/world/gen/` inherits that the moment it exists. `src/materials/` is
   the one M5 directory where `three` is legal.
3. No `Math.random()`. Use `ctx.rng` or your own `ctx.rng.fork()` taken once in
   `init()`. World generators draw from the named streams of 07 §1.8 (S0 macro,
   S1 shape, S2 dress, S3 spawn), never from ctx.rng directly.
4. Simulation lives in `fixedUpdate` (60 Hz) and never reads `dt` or the wall
   clock, including `performance.now()`. Presentation lives in `update`.
   Schedule against `ctx.time.step`. Cooldowns, fuses, wind-ups, leash timers
   and transition envelopes are all fixed-step quantities.
5. Zero allocation per frame. Vectors, pools and scratch buffers are built in
   `init()`. `Math.hypot` is banned — use `Math.sqrt(x*x + y*y)`. `Map` is banned
   for recycled or pooled state, and `Map.prototype.clear()` allocates even when
   the map is empty; the house idiom for recycled slots is a generation stamp in
   a flat typed array. Template strings in a hot path allocate — dispatch on an
   integer index resolved once, not on a string id.
6. Gameplay numbers live in `data/`, not in code. If the specification does not
   give you a number, stop and ask — do not choose one.
7. A public method exists only if `docs/spec/02-api-contracts.md` lists it, with
   its `Fixed` and `Alloc` columns. If you need a new one, say so in the report
   and wait — another agent may be holding that file. Do not invent API
   silently. A contract method must be reachable as a method on the subsystem
   the contract names, not only as an exported module function.
8. `npm run build` must pass and `npm run capture` must still produce a frame.
   Breaking the boot blocks every other ticket.
9. Do not write tests outside your ticket and do not touch fixtures or blessed
   PNGs. A test that asserts a time, an allocation or a frame goes in a file
   named `<thing>.perf.test.js` so the runner isolates it.
10. Git: no commits, no pushes, no branch operations. And specifically: no
    `git stash`, `checkout`, `restore`, `clean`, `reset`. Another agent may be
    working in the tree right now. Need a file out of the way? Rename it.
    (This has been violated once already, in M3, by an agent that believed it
    was being careful.)
11. Do not assert "nothing else exists yet". Counts of subsystems, zones,
    archetypes, bodies and exact pixels all change every milestone; assert the
    behaviour your test exists for.
12. If your criterion is a sweep, report the counts — how many seeds ran, how
    many passed, the distribution of the quantity being bounded. A sweep that
    reports "green" without counts is not evidence, and a harness that meets a
    time budget by running fewer cases does not pass.
13. Do not add game content. No seventh archetype, no tenth affix, no fourth
    zone, no boss phase. The shipped lists are the shipped lists until M7.

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
   "Done when". If it is an assertion id (`I4`, `MB13`, `12.D02`), run the
   harness that produces it — do not settle for "the file exists".
3. **Read the counts, not the verdict.** M5's specific discipline. A sweep
   reports how many seeds ran and how many passed; check that the first number is
   the number you asked for. 5 400 is 5 400. A 600-layout check that quietly ran
   60 is the M5 shape of NAV-2's abort, and it will read as green.
4. **Re-derive one number by hand, for every ticket that carries one.** Pick an
   intermediate the agent did *not* highlight: one room count out of the BSP, one
   cell's spawn budget against `07` §8.2's density table, one archetype's life at
   mlvl 10 against `06` §2's printed column, one transition leg's millisecond
   split.
5. **Tests.** `npm test`, both stages. For perf- or GC-sensitive tickets run it
   more than once, and never while a subagent is working (§3.4). Remember O-85
   before you call an allocation probe a regression.
6. **Lint.** `npm run lint`. Cheapest guard against the most expensive mistake:
   a DOM global or `three` leaking into headless code kills the whole Node test
   surface. Confirm the file count rises as `src/world/gen/` and `src/ai/`'s new
   files land, and that `src/materials/` did **not** become a headless root.
7. **Read the diff.** `git status --short`, then `git diff` over the ticket's
   files. Six things tests do not catch:

   | What | How you catch it |
   |---|---|
   | edits outside the owner directory | `git status --short` shows extra files |
   | importing another subsystem directly | `grep -rn "from '\.\./\(actors\|combat\|nav\|world\|physics\|items\|ui\|skills\)" src/ai src/world` — must be empty; everything goes through `ctx.get()` |
   | `Math.random()` | `grep -rn "Math.random" src/` — exactly one legal hit, in `src/main.js` |
   | allocation in the frame | array/object literals, template strings and `Map` inside `update`/`fixedUpdate` or any `Alloc = no` method |
   | wall clock in the fixed path | `grep -n "dt\|performance.now" <file>` inside `fixedUpdate` — see O-40 |
   | gameplay numbers hard-coded | magic constants where the spec says `data/` |

8. **Independent behavioural probe.** Do not just rerun the subagent's test —
   write your own throwaway check in the scratchpad and compare. M0 rejected four
   tickets this way, M1 two, M2 several, M3 and M4 more. **M5's highest-value
   probe is a scripted zone traverse against a real `boot()`**: enter the Wastes at
   a fixed seed, walk entry to exit, count the packs that woke, the paths that were
   refused, the props that drew, and the frames the transition took. It catches
   what every unit test in the milestone will pass — a generator that is correct
   and a zone that is unplayable.
9. **Frame.** `npm run build && npm run capture`, then `imagediff` against the
   blessed baselines. `boot_clean`, `ui_clean`, `inventory_full` and
   `skill_tree_ravager` stay at `diffPixels=0` throughout M5 — none of M5's work
   should touch them, and if one moves, find out why before you re-bless anything.
   For the three new shots: **look at the PNG with your own eyes** before blessing,
   and record in the journal that you did. M1's journal notes a frame that did
   *not* change when the prompt predicted it would — check, do not assume, in both
   directions.

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
appended to the existing table, matching its columns:
`ID | Дата | Файлы | Проверено чем | Заметки`, with the round count in the date
cell (`2026-08-03 (2 круга)`). A subagent's report is not a row; your own
verification is.

Keep the rest of the document alive too:

- **§1.1's nine reconstructed M4 rows land first**, labelled as reconstructed;
- **D-60…D-72 get written down as D-entries** so M6 does not re-litigate them;
- new interface questions go into the O-table with an owner ticket, continuing
  from **O-95** (O-94 is the highest in use);
- new decisions continue from **D-73** (D-72 is the highest in use);
- a question you resolve gets its resolution written down. M5 should close
  **O-67**, **O-94** (at least cause 3), **O-61**'s world half, **O-78**'s second
  half, **O-92**, **O-93**, and must record an answer for **O-9**, **O-49**,
  **O-79**, **O-81**, **O-87** and **O-88**;
- a performance finding that cost someone a rewrite goes into the rules section;
- update the status line at the top, add the missing **M2, M3, M4** rows to the
  milestone-gate table, and add M5's when it closes.

The document exists so a fresh session understands the state in one minute
without rereading 200 tickets. Write it for that reader — M5 is the milestone
that proves whether that is still true.

## 10. The M5 gate

When all 18 tickets are accepted, run the gate — and do not treat it as a
formality:

| # | Check | Source |
|---|---|---|
| ① | `npm run build` green | backlog, definition of done |
| ② | `npm test` green, **several consecutive runs**, both stages | M0–M4 precedent |
| ③ | `npm run lint` green, `src/world/gen/` and the new `src/ai/` files live under their existing roots, file count risen from **96**; `src/materials/` correctly **not** a headless root | 12 §2.1, D-72 |
| ④ | **`node tools/mapgen.mjs` green on 5 400 layouts** — three zones × 200 world seeds × three run indices — with **`07.I01`–`07.I09`** passing, and the run **printing the count it actually evaluated** | 12 §5.5, 12 §11 M5 row — *the* M5 gate |
| ⑤ | **`12.D02`** — two `mapgen.mjs` runs at one seed produce identical layout hashes | 12 §7 |
| ⑥ | **`node tools/balance.mjs --monsters` green** — every `06.MB` assertion reachable in M5: MB1, MB2, MB3, MB4, MB7, MB8, MB9, MB10, MB11, MB12, MB13, MB16, MB17, MB18, MB19, MB20. MB5/MB5b (Molgrim) and MB6 (class spread) report **`skip`**, loudly, naming M6/M7 | 12 §11, 06 §12.2, D-64 |
| ⑦ | **A zone is walkable end to end**, as a real scripted session through `boot()`: enter the Ashen Wastes, walk entry to exit, and again for Bonereach | backlog M5 gate |
| ⑧ | **The corridor check, run for real**: a 12-pack in a 3.0 m Bonereach corridor presents 3 abreast and never single-files | 06 §8.5, AI-5 |
| ⑨ | **Transitions**: town → wastes → portal to town → return → descent → altar, ten times; ≤ 1100 ms per leg, black window ≤ 600 ms, ground items and chest flags surviving the round trip, a cleared pack not respawning | 07 §10, §12 row 11 |
| ⑩ | **`wastes_seed_a`, `wastes_seed_b`, `bonereach_hall` and `dense_combat` registered, captured, reviewed by eye, blessed and committed**, each with an honest `description` | 12 §9.1, D-69 |
| ⑪ | **M4's gate item ⑧ finally green** — each class clears the test room against monsters with real life — or an explicit, owner-acknowledged statement of which of O-94's three causes still blocks it | O-94, D-61 |
| ⑫ | M2–M4 must not regress: `03.E01`–`03.E14` still exact; `lootsim` still green with `12.D03`/`12.D08`; `balance.mjs --skills` still green; `12.A01`/`A02`/`A05` still green — **with every new `Alloc = no` method added to `12.A01`'s list**; all four existing blessed shots still `diffPixels=0` | M2/M3/M4 gates |

Item ④ is the milestone. It is also the easiest to fake, in two directions: a
sweep that runs fewer layouts than it claims, and an invariant that passes
because it was weakened. Read the printed counts and read the invariant
implementations, not just the exit code.

Item ⑦ is easy to skip and it is the only check that proves the milestone
produced a *game* rather than a data structure. Run it as real sessions through
`boot()`, not as a battery of unit tests each covering a slice.

Item ⑩ is easy to fudge. Say plainly what each frame contains and what it does
not. M2's O-56, M3's D-22 and M4's `skill_tree_ravager` are the precedents, and
they are good ones.

Red gate = milestone not closed. There is no "we will fix it in M6": M6 is town,
quest and boss — every one of which is placed, navigated and fought inside the
zones this milestone is supposed to have proved.

**When the gate is green, stop.** Do not start M6. Report to the owner: tickets
closed, gate results item by item, what was hard, which specs proved wrong or
ambiguous, what should be revisited in the plan. M6 starts on a direct order,
exactly as M1–M5 did.

## 11. Git

**No commits. No pushes.** Not by you, not by subagents. Take the work to
"changes are ready" and stop. The owner grants commit permission separately and
freshly each time; permission from a previous turn does not carry over. No
`rebase`, `reset --hard`, `merge`, branch or tag deletion.

**Also forbidden: `git stash`, `checkout`, `restore`, `clean`, `reset`** —
anything that touches the working tree as a whole. M0–M4 are committed at
`6bba962`, so there is a real restore point; M5's in-flight work is not, and with
two or three lanes running there may be three tickets' worth of uncommitted code
in the tree at once. An agent already violated this once, in M3, while believing
it was being careful.

`docs/PROGRESS.md` is the only file you write yourself.

When M5 closes, say the work is ready and offer to commit — then wait.

## 12. Stop and ask the owner when

- two documents require **incompatible** things — a contradiction, not an
  ambiguity. Everything of this kind that was known on 2026-08-02 is already
  ruled on in §4.2. So this applies to what you find **new**, and you should
  expect to find some: `06` and `07` cross-reference each other constantly and
  each owns numbers the other quotes;
- a ticket needs a **number no spec provides** — never invent one. M4 recorded
  one fabricated curve (`src/save/schema.js:76–87`) and one number that lived in
  a document nobody would have opened (D-47). Assume there are more; `07` §8's
  density tables and `06` §6.5's danger budget are the likely sites;
- a documented layout, trace or table does not reproduce *and* the implementation
  looks right. That is a finding about the spec — `03` §12 has been found
  internally inconsistent four times, `05` §11.1 once (D-50), `05` §12.7 once
  (D-54) — not a licence to adjust the expected value or widen the tolerance;
- the gate stays red after three attempts;
- something would add **game content** — a seventh archetype, a tenth affix, a
  fourth zone, a boss phase, an item. The plan forbids that before M7;
- the work would go outside the backlog.

Do not stop for routine: private function names, file layout inside your own
directory, field order. Decide and move.

## 13. Reporting

Per ticket, short:

> `WRLD-5` accepted. `src/world/gen/ridgewalk.js`. `npm run build` green,
> `npm test` 2104/2104 across both stages. The sweep ran **200 seeds, 200
> connected** — I checked the printed count, not the verdict — `|connected|`
> landed in [9,14] on all 200 with the distribution centred on 11, L-path
> fallback fired **0 times** (spec allows < 0.1 %, i.e. up to 0). Two runs at
> seed `0x4c00751` produced identical cell arrays; I diffed them myself rather
> than trusting the equality assert. Pure functions, no `three`, runs under
> `node --test` in 1.8 s. Next: `WRLD-6`.

Per milestone, a table: tickets, gate results, what surfaced, what to revisit.
Do not narrate diffs. The owner tracks state and blockers.

## 14. Start here

1. Read the six items in §2 — including `07` §1, §7, §12 and `06` §1, §12, §13
   in full, before anything else.
2. Run `npm run build`, `npm test`, `npm run lint`, `node tools/balance.mjs
   --skills`, `git status --short` and `git log --oneline -3`, and record the real
   baseline. You will need it to prove nothing was lost.
3. **Close §1.1** — write the nine missing M4 journal rows, fix the stale status
   line, add the missing gate-table rows. This is phase 0 and it comes before
   ticket 1.
4. Walk §4.2 and **verify** each of the thirteen rulings against the current
   files — do not take this prompt's word for any of them; line numbers drift and
   the tree moves. You are checking they still hold, not deciding them again. If
   one does not hold, say so in your first report; otherwise say "thirteen
   rulings verified" and move on.
5. **First report, for information, not for permission:** the thirteen rulings
   verified (or the exception), the state of M4's residue, and what happens to
   O-67, O-79, O-81, O-49, O-78, O-92, O-93, O-61, O-9, O-87 and O-88 in M5,
   ticket by ticket, or that they are carried. **Two things in it are for the
   owner**: D-54's ruling, and what to do about O-94's causes 1 and 2. Then keep
   going — you do not wait for an answer to start ticket 1.
6. Create tasks (`TaskCreate`) for the 18 M5 tickets in the §3.2 order, so
   progress is visible.
7. Report the plan: 18 tickets, `ACTR-24` alone first, then `MATL-1` alone, then
   two lanes —
   `world: WRLD-4 → WRLD-5 → WRLD-6 → WRLD-7 → WRLD-9 → WRLD-8 → WRLD-10` and
   `ai: AI-3 → AI-4 → AI-5 → AI-6 → AI-7 → AI-8 → AI-9` — with `UI-11` floating
   into whichever lane frees first after `WRLD-4`, `AI-7` joining at `WRLD-9`,
   and `TEST-9` last, after both `WRLD-8` and `AI-8`.
8. Launch `ACTR-24`.
