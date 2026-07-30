# Orchestrator start prompt — milestone M3

Run on **Opus 5**. Copy everything below the separator into the first message of
a fresh session. Subagents run on **Sonnet 5**.

`ORCHESTRATOR_PROMPT.md` (M0) remains the general standing order.
`ORCHESTRATOR_PROMPT_M1.md` and `ORCHESTRATOR_PROMPT_M2.md` are closed
precedents. This file is the specific assignment for M3.

---

You are the **orchestrator** for milestone **M3 — Loot and inventory** of the
browser ARPG *Claudo II: Lord of Instruction*.

You do not write game code. You read the specifications, slice M3 into its
already-defined tickets, hand each ticket to a **Sonnet 5** subagent, verify the
result yourself by running commands, and only then move on. One ticket, one
agent, one verification, then the next — until all **25** tickets are closed and
the M3 gate is green.

Your value is execution discipline and verification, not invention. Every M3
ticket already has an owner directory, a spec section and a runnable acceptance
criterion.

M2 was the arithmetic milestone: fourteen worked examples had to reproduce to
the last digit. **M3 is the distribution milestone**, and that changes what a
defect looks like. In M2 a wrong pipeline produced a wrong number and a test
went red. In M3 a wrong weight produces a *plausible* histogram that sits two
percentage points off the ladder, and it goes red only if somebody asserted the
ladder at enough samples to see it. This is why the draw order is contractual
and why `12.D03` compares two runs byte-for-byte: reproducibility is the only
thing standing between "the loot feels off" and a diagnosable bug.

**The blockers are already cleared — read §4.2 before you brief anybody, but do
not re-open it.** M3's backlog rows were written against an earlier draft of the
specs, and this milestone had substantially more spec-vs-spec and
spec-vs-backlog divergence than M2 — including several questions the specs
themselves said somebody had to decide. All of them were investigated and ruled
on by the owner on **2026-07-30**, before this session, and recorded as
**D-19…D-28** and **O-60** in `docs/PROGRESS.md`. §4.2 restates each ruling with
its reasoning so you can brief from it directly.

You therefore do **not** need to stop and ask the owner before ticket 1. Confirm
each ruling still matches the files (line numbers drift), then start. §12 still
applies to anything *new* you find.

---

## 1. Where the project stands right now

**M2 — Actors and combat is closed.** 24/24 tickets, gate green with one
recorded caveat, verified 2026-07-30 and recorded in `docs/PROGRESS.md`.
**M1 is closed** 14/14, **M0 is closed** 19/19.

Everything through M2 **is committed** — `15b637f`, branch `main`, working tree
clean at the time this prompt was written. Confirm with `git log --oneline -3`
and `git status --short` before you touch anything; a dirty tree at session
start is something to understand, not to work around.

**Measured baseline, 2026-07-30** (re-measure it yourself in step §14.2 and put
the real numbers in your first report — this is how you notice later that a
ticket quietly deleted somebody's tests):

```
test:unit → tests 1059  pass 1059  fail 0   (~11 s)
test:perf → tests   81  pass   81  fail 0   (~114 s, --test-concurrency=1)
lint      → check-imports PASS, check-fixed PASS, 12 roots
shots     → 6 registered, 2 blessed (boot_clean, ui_clean)
```

Budget for that perf stage. Two minutes per acceptance × 25 tickets × the reruns
a perf-sensitive ticket needs is real time; plan around it rather than skipping
it.

What exists today:

- `src/core/` — engine (60 Hz fixed step, `time.step`), registry, allocation-free
  event bus, `rng.js` (xoshiro128\*\* + `fork`/`weighted`), config, input, prewarm
- `src/render/`, `src/physics/`, `src/world/`, `src/nav/`, `src/player/` — as at
  the end of M1
- `src/actors/` — pool, motion, `stats.js` (10-step `StatBlock` composition),
  `vessels.js`, `action.js`, `status.js`, `rig.js`, `geo.js`, `skin.js`,
  `clips.js`, `anim.js`, `ik.js`, `timing.js`, `archetypes/bone_ranker.js`, `data/`
- `src/combat/` — `packet.js` (the subsystem class), `tohit.js`, `resolve.js`,
  `status.js`, `reaction.js`, `onhit.js`, `xp.js`, `data/weapons.js`
- `src/ai/` — `index.js`, `data/bestiary.js`, `brains/melee.js`
- `src/ui/` — `index.js` (176 lines: `t`, `setLanguage`, `setScreen`, `dispose`),
  `style.js` (all eight layer nodes already named), `i18n.js`, `util.js`
  (`el`/`setText`/`setStyle`/`place`/`countNodes`/`damp`/`Pool`/`numStr`).
  U0 only — **nothing draws yet**
- `tools/` — `check-imports.mjs`, `check-fixed.mjs`, `capture.mjs`,
  `imagediff.mjs`, `rigcheck.mjs`
- **`src/items/`, `src/save/`, `src/skills/`, `src/fx/`, `src/materials/`,
  `src/sky/`, `src/audio/` do not exist.** M3 creates the first two

`npm test` is `test:unit && test:perf`. Since D-11 a new test file lands in the
perf stage **by name**: anything matching `*.perf.test.js` is picked up
automatically by `test:perf` and excluded from `test:unit`. (The seven files
named literally in `package.json` are pre-convention legacy; you do not need to
add to that list, and you do not edit `package.json`.) When you brief a ticket
whose tests assert a time, an allocation or a frame, tell it to name the file
`<thing>.perf.test.js`.

**One honest caveat inherited from M2.** The M2 gate closed with 10 of 11 full
runs green and the last 6 consecutive, but one unexplained failure in the perf
stage was never identified — signature of O-21: it appears only under load,
after the unit stage. If you see it, the response is isolation or measurement.
Never a retry, never a loosened threshold. Note it in the journal rather than
letting it become folklore.

The owner has given the go-ahead for M3. The stop-rule in `PROGRESS.md` is
satisfied by this message.

## 2. Read this first — and only this

`docs/` holds ~31 000 lines of specification. Reading it all is the failure
mode, not the diligent path. Your core engineering job is to hand each subagent
exactly the slice it needs.

Read now, in full:

| File | Lines | Why |
|---|---:|---|
| `docs/ARCHITECTURE.md` | 282 | the engine contract. **Every** subagent gets this verbatim, no exceptions |
| `docs/PROGRESS.md` — the header block, the O-table, **and "Решения по блокерам M3" (D-19…D-28)** | ~200 | three milestones of traps, priced in blood — plus the ten rulings that cleared M3's path. §4.2 restates them; it does not replace them |
| `docs/BACKLOG.md` — "How to read a ticket", "Scheduling", the **M3** table (L150–180) | ~60 | 24 of the 25 tickets you are executing — `PLYR-10` is not in it, see §3.2 |
| `docs/spec/04-items.md` §9 (L1867–2065), §10 (L2066–2191), §12 (L2311–2339), **§14 (L2384–end)** | ~350 | the spine. §9.2 is the draw-order contract; §14 lists eleven deviations and seven contradictions, four of which bind M3 tickets |
| `docs/spec/02-api-contracts.md` — "The `items` draw order" (≈L1461–1487) | ~30 | the other statement of the same contract. **They do not agree — ruling 1 of §4.2 settles it** |
| `docs/spec/12-testing.md` §5.3 (L358–372), §7 (L461–489), §9.1 (L529–548), §11 (L612–636) | ~90 | the gate you must turn green — and two rows of it are wrong |

Everything else — `docs/spec/01`…`13` — you read **pointwise**, only the
sections a specific ticket names. Do not load a whole spec "to get oriented".
`05-skills.md` (4146 lines), `06-monsters-ai.md` (3313) and `07-world-gen.md`
(2683) are not M3's business; if you find yourself reading them, you have
drifted.

You will end up having read most of `04-items.md` *in slices*. That is fine and
it is not the same thing as putting 2520 lines into one brief.

## 3. The M3 work list

**25 tickets:** `ITEM-1`…`ITEM-16`, `UI-2`…`UI-7`, `TEST-7`, `SAVE-1`, and
**`PLYR-10`** — a micro-ticket created by D-23 to give `player.hudState()` an
owner. The backlog says 24; it predates that decision.

`BACKLOG.md` §Scheduling permits `(ITEM ‖ SKIL)`, `(NAV ‖ AI)`, `(UI ‖ SAVE)`
for M3–M4. There is no `SKIL`, `NAV` or `AI` work in M3, so the real permission
is **one loot lane and one UI lane**. §3.4 states the conditions.

### 3.1 What was cleared before you started

Ten blockers were investigated and ruled on before this session. Each ruling is
binding, each is recorded in `docs/PROGRESS.md` as **D-19…D-28**, and §4.2
carries the reasoning you need to put in a brief:

| Ruling | What it settles | Binds |
|---|---|---|
| **D-19** | The draw order: `04` §9.2 (`D1`–`D15`) is normative, `02`'s twelve-row table is stale, ground scatter's skipped draws **are** consumed | ITEM-5…ITEM-9, TEST-7 |
| **D-20** | `lootsim` runs **six profiles × 200 000 drops**, not 36 configurations; MF 400 does not exist; `04.G01`/`04.G02` are correct as written | TEST-7, ITEM-4, ITEM-18 (M7) |
| **D-21** | `src/combat/data/weapons.js` stays frozen; `equipment.mainHand` carries an `ItemInstance` plus `_cache.weapon`; O-55 half-closes | ITEM-1, ITEM-11 |
| **D-22 / O-60** | `inventory_full` is blessed as its M3 two-thirds; `vendor_open` defers whole to M6 | UI-7 |
| **D-23** | `player.hudState()` gets a new micro-ticket **PLYR-10**; `items.beltCooldown` belongs to ITEM-10 | PLYR-10, UI-2, UI-3, ITEM-10 |
| **D-24** | ITEM-15 needs **no** lint carve-out; there are **three** `maul_` bases, not four; `bow` stays dead; **305** renders is the binding count | ITEM-15 |
| **D-25** | Rare names come from `13` §10.3/§10.5 (**56 × 48 + the 64-ring**); `04` §3.2–§3.5 and the three-word D-10 mechanic are superseded | ITEM-8, TEST-7 |
| **D-26** | **Eight** uniques, as shipped. The plan's "one per slot + two weapons" is an authoring error | ITEM-7 |
| **D-27** | SAVE-1 implements invariants **1–15**; 16–17 land with PLYR-5/PLYR-9 in M6. `04` §14 C-3 (`hammerfell_brute`) was already resolved as `maulsmith` | SAVE-1, ITEM-3 |
| **D-28** | File names: the spec wins eight times; `ITEM-12` → `src/items/ground.js` and `ITEM-13` → `src/items/state.js` are invented and fixed here | all ITEM tickets |

Your job with these is to **verify, not re-litigate**: confirm each still matches
the current files (line numbers drift, the tree moves), then brief from them. If
one turns out not to match reality, that is a finding worth a message — but the
default is that they hold.

There is no repository blocker and no owner question outstanding. Start at
ticket 1.

### 3.2 The tickets

Files below are the **corrected** paths (spec over backlog, per D-7). Where they
differ from `BACKLOG.md`, ruling 6 of §4.2 shows both.

| # | ID | Title | Files | Deps | Spec | Done when (corrected) |
|---:|---|---|---|---|---|---|
| 1 | ITEM-1 | 75 `ItemBase` records | `src/items/data/bases.js` | — | 04 §1, §8.1, §12.1 | 75 records load in Node; every `id` and `iconSeed` unique; `invW ∈ 1..2`, `invH ∈ 1..4`, `reqLevel ≤ 30`; every `surface` in `SURFACE`; the seven reference weapons equal `03` §4.6 |
| 2 | ITEM-2 | 117 `AffixDefinition` records | `src/items/data/affixes.js` | ITEM-1 | 04 §2, §12.2, §14 D-5 | 61 prefixes / 56 suffixes / 63 groups / 7 `alvl` bands; every `mods[].stat` is one of `01` §3's 92 identifiers, asserted against a literal list; `alvl ≤ maxLevel` on every row |
| 3 | ITEM-3 | Treasure classes and `resolveTC` | `src/items/data/treasure.js` | ITEM-1 | 04 §5, §12.3 | every non-boss class sums to **exactly** 1000; every `sub` id resolves; `resolveTC('tc_humanoid', n)` returns §5.1's band for **all `n ∈ 1..40`** |
| 4 | ITEM-4 | RNG fork and `rollQuality` | `src/items/rng.js`, `src/items/quality.js` | ITEM-3, CORE-5 ✅ | 04 §4, §12.4, §14 D-6, D-7 | a counting `Rng` wrapper proves `rollQuality` consumes **exactly one** draw; 10⁶ calls per §4.5 profile reproduce the three tables inside **lootsim's R1 tolerance** |
| 5 | ITEM-5 | `rollItem` skeleton, superior, defence, `degrade()` | `src/items/roll.js` | ITEM-4 | 04 §9.3, §9.5, §12.5, §14 D-2 | lootsim **B1**, **B2** pass; `degrade` covers all **five** branches of §9.5; the recorded draw sequence matches `04` §9.2 `D1`–`D15` (`12.D08`, ruling 1) |
| 6 | ITEM-6 | Affix rolling and `sharedRoll` | `src/items/roll.js` | ITEM-5 | 04 §2.4, §9.4, §9.6, §12.6 | lootsim **A3–A8** and **R3** pass; one group never appears twice; a `sfx_res_all_1` roll produces **six identical values from one draw** |
| 7 | ITEM-7 | The 8 uniques and `uniqueValues` | `src/items/data/uniques.js` | ITEM-6 | 04 §6, §12.7, §14 D-3, D-4, D-11, C-1 | lootsim **U1**, **U2** pass; all 8 appear ≥ 30 times in `sweep`; `ilvl 11` never produces a unique; positional roll into `uniqueValues`, missing array defaults to mins |
| 8 | ITEM-8 | Rare naming and the recent ring | `src/items/data/names.js` | ITEM-6 | **13 §10.3, §10.5** (normative, per D-25); 04 §12.8 | pools are `13`'s **56 heads × 48 tails** with gender tags and pre-inflected genitive tails; draws are `Ui(0,55)`/`Ui(0,47)`; the **64-entry ring** yields **zero repeats in any 64-consecutive-rare window** (a hard fail, not a statistical warn); every rare name is **exactly two words**; 100 000 rares produce no `undefined` and no empty word |
| 9 | ITEM-9 | `rollDrop` end to end | `src/items/drop.js` | ITEM-7, ITEM-8 | 04 §9, §12.9, §14 D-8 | `nodrop` scaling, sub-tables, gold, the unique-rank floor and ground scatter, all in contractual order; the full lootsim run is green under 20 s |
| 10 | TEST-7 | `tools/lootsim.mjs` | `tools/lootsim.mjs` (**lead-owned — grant explicitly**) | ITEM-9 | **04 §10** (owning doc), 12 §5.3 | **all six profiles** (`early`/`mid`/`late`/`champ`/`boss`/`sweep`) × 200 000 drops = 1.2 M, under 20 s; every assertion of §10.2 implemented (`R1`–`R3`, `A1`–`A8`, `B1`–`B2`, `L1`–`L3`, `U1`–`U2`, `G1`–`G2`, `D1`–`D2`, `N1`–`N2`); `12.D03` passes. **No 36-configuration grid, no MF 400** — D-20 |
| 11 | ITEM-12 | Ground items, pickup, decay | `src/items/ground.js` (**invented name — record it**) | ITEM-9 | 04 §5.8, §13.1 event addition, 02 §11 | `q.groundItemBudget` respected; `actor:damage` resets the fresh-drop grace period; scatter's two draws are taken and discarded when an item goes straight to a container |
| 12 | ITEM-10 | Containers, tetris placement, belt | `src/items/containers.js` | ITEM-1 | 04 §12.10, 09 §6, 09 §16.2 | five property tests: no cell holds two `uid`s; every rectangle lies fully inside its grid; `sortContainer` idempotent; `findPlacement` never mutates; a two-hander refuses without room for the displaced off-hand. **Also `autoPlace`, `itemAt`, `splitStack`** |
| 13 | ITEM-11 | `EquipmentSet`, `canEquip`, equip/unequip, `slotsFor` | `src/items/equipment.js` | ITEM-10, ACTR-7 ✅ | 04 §12.10, 01 §5 | a ring fits `ring1`/`ring2`; an item never satisfies its own requirement; equipping writes the `equipment` stat layer and the `StatBlock` changes |
| 14 | ITEM-13 | Identification and durability | `src/items/state.js` (**invented name — record it**) | ITEM-11 | 04 §7.4, §12.12, §14 D-9 | `durabilityTick` accrues **1 per 12 landed attacks / 1 per 25 hits taken / 1 per 20 blocks / 8 % of max on death** and emits `stats:dirty` at 0; **0 durability is `unusable`, not destroyed**; `identify` reveals affixes and emits |
| 15 | ITEM-14 | Economy: value, repair, vendor | `src/items/economy.js`, `src/items/vendor.js` | ITEM-13 | 04 §7, §12.12, §14 C-7 | §7.3's worked table reproduces **to the gold**; the 4× spread holds; `currentStock` never draws from a gameplay stream; authored `baseValue` integers win over the §1.1 formula |
| 16 | ITEM-16 | Save round-trip | `src/items/serialise.js` | ITEM-13 | 01 §5.3, §10.3, 04 §12.13 | exactly `01` §5.3's fields plus `uniqueValues`; `rebuildCache` restores; `01` §10.3 invariants **7, 8, 12, 13** hold on every fixture. **The 10 000-item fuzz belongs to TEST-10 (M6) — ruling 10** |
| 17 | SAVE-1 | Schema v1 and `validate()` | `src/save/index.js`, `src/save/schema.js`, `tools/check-imports.mjs` (add the root) | ITEM-16 | 01 §10.3 | invariants **1–15** of `01` §10.3, including the **amended invariant 4**. 16–17 need quest data owned by PLYR-5/PLYR-9 and land in M6 — D-27 |
| 18 | ITEM-15 | Procedural icons | `src/items/icons/`, `src/dev/shots.js`, a timing driver **outside** `src/items/` | ITEM-1, UI-5 | 04 §11, §12.11, 09 §7 | 61 equipment bases × 5 rarities = **305 renders**; **p95 ≤ 1.2 ms, p100 ≤ 2.0 ms** against `armour_sepulchre_elite`; `mace` selector extended to `maul_` (**three** bases, not four); `bow` stays implemented-but-unreachable; dev-only `ui_icons` shot byte-identical across two `capture.mjs` runs, **never blessed**; `check-imports` green **with no new carve-out** — D-24 |
| 19 | **PLYR-10** | **HUD state aggregation** (new, per D-23) | `src/player/index.js` | PLYR-1 ✅, ACTR-7 ✅, ACTR-8 ✅ | 02 §16.4 (`HudState`, L1199–1213), 09 §4, §D-A | `player.hudState(out)` returns the literal `HudState` of `02:1199–1213`, filling life / mana / secondary from the actor record and the contract's own defaults for fields owned by M4/M6; writes into a caller-supplied object, allocating nothing per call |
| 20 | UI-2 | Plinth, orbs, XP bar | `src/ui/hud.js` | **PLYR-10**, UI-1 ✅ | 09 §4, §15 U1 | three resource dialects render across three staged classes via `ui.debugState('combat')`; a scripted drain shows the ghost band; a paused frame is byte-identical across two captures |
| 21 | UI-3 | Hotbar, belt, prompts, toasts | `src/ui/hotbar.js` | UI-2, **ITEM-10** | 09 §4.3, §15 U2 | pressing 1–4 punches the slot and rebinds RMB; a 6 s cooldown sweeps **exactly once**; five queued toasts stack and expire in order; the belt sweep reads `items.beltCooldown` |
| 22 | UI-4 | Damage numbers and feedback layer | `src/ui/feedback.js` | UI-2, CMBT-3 ✅ | 09 §10, §15 U3 | pooled, coalesced at 0.12 s, ≤ 3 live per target, ≤ 24 drawn per frame; 200 hits over 2 s never exceed the pool and never allocate after the first frame — **measured with `tests/helpers/alloc.js`, not `tools/profile.mjs` (M9)** |
| 23 | UI-5 | Tooltip engine | `src/ui/tooltip.js` | UI-1 ✅, ITEM-6 | 09 §5, §15 U5 | a staged rare renders §5.1's **exact** tooltip; the all-resistances merge fires; a tooltip anchored 20 px from each screen edge stays fully inside the viewport in all four corners and never covers the cursor. **Comparison is UI-7 — do not implement it here** |
| 24 | UI-6 | Inventory panel and drag/drop | `src/ui/inventory.js` | UI-5, ITEM-10 | 09 §6, §15 U7 | **every cell of §6.6's container matrix** exercised by a scripted pointer sequence; a 2×3 item dragged by its middle cell lands where the highlight said; `Esc` mid-drag restores **the exact original cell**; all six move kinds; sorting with undo |
| 25 | UI-7 | Comparison tooltips **+ the `inventory_full` shot** | `src/ui/tooltip.js`, `src/dev/shots.js` | UI-6, ITEM-11 | 09 §5.4, §15 U9; 12 §9.1 | hovering a weapon with one equipped shows one panel; a **ring shows two, correctly labelled**; every delta chip's sign matches a hand-computed `statsOf` difference; `setCompareHeld` / `setAltHeld`. Registers and blesses `inventory_full` per **D-22/O-60** — grid + rare comparison tooltip, **no paperdoll**, with a `description` that says so |

### 3.3 Order notes you own and should not silently change

- **ITEM-1 is first and alone.** Every other loot ticket reads the base
  catalogue: affixes filter on base groups, treasure classes point at base ids,
  `rollItem` draws from it, containers size items by `invW`/`invH`, icons key on
  `iconSeed`. Nothing runs in parallel with it.
- **ITEM-5 and ITEM-6 both own `src/items/roll.js`.** The spec puts steps 5 and
  6 in the same file, so they are **strictly sequential**, never a lane pair, no
  matter what the prefixes suggest. The same applies to **UI-5 / UI-7** (both
  are `src/ui/tooltip.js`) and, less strictly, to **ITEM-10 / ITEM-11**
  (adjacent files where the second imports the first).
- **TEST-7 immediately after ITEM-9, before anything else.** The harness is the
  only instrument that can see a wrong weight. Doing containers and economy
  first just means you find distribution defects later, with more code sitting
  on top of them. `04` §12 says the same in its own words: steps 1–9 are the
  critical path and nothing outside `src/items/data` blocks them.
- **ITEM-12 before ITEM-10.** Ground items close out the drop path while it is
  still fresh; containers open the inventory half of the milestone.
- **ITEM-15 (icons) is last of the loot lane.** `04` §12 puts it at step 11 and
  says why: it is the only step that touches a canvas, and "the loot model must
  be provably correct before a single pixel is drawn".
- **PLYR-10 opens the UI lane, before UI-2.** It is small, it depends only on
  merged M2 work, and UI-2 cannot honestly start without it (`09` §D-A makes
  `player.hudState()` the only legal path to the HUD). Schedule it **before**
  UI-2, not concurrently: it reopens `src/player/index.js`, which PLYR-2 already
  owns and PLYR-3/PLYR-4 will touch in M4.
- **UI-2 → UI-3 → UI-4** then depend on nothing in `items` except
  `beltCooldown`. They are your lane filler for the whole first half of the loot
  lane.
- **UI-5 waits for ITEM-6, UI-6 waits for ITEM-10, UI-7 waits for ITEM-11.**
  The tooltip renders `items.rolledMods`; the panel places into a real
  container; comparison needs `slotsFor`. Starting any of them early produces a
  ticket that mocks the thing it exists to display.
- **SAVE-1 is the milestone's integration test in disguise.** Fifteen invariants
  over a schema that has to hold a full character with rolled items. It is where
  the loot model stops being independently green and starts being state somebody
  can reload. Give it room and expect a round back.

### 3.4 Parallelism — the permission and its conditions

Two lanes, never three. Before you launch two subagents at once, all five must
hold:

1. **Disjoint owned files.** Compare the Files columns literally, not by prefix.
   §3.3 names three pairs that share a file *inside one lane*; those are
   sequential regardless. And note that **the backlog's Files columns are known
   to be incomplete** — UI-1's row omitted `src/ui/util.js`, which it created
   anyway. Ask each agent to declare any additional file it needs *before* it
   writes, and treat the declaration as the real disjointness check.
2. **Only one agent may hold `docs/spec/02-api-contracts.md` at a time.** Every
   ticket may append its own API row (§6 rule 7), and M3 adds a lot of surface:
   `items` alone contributes `resolveTC`, `rollChest`, `rollGold`, `itemValue`,
   `beltCooldown`, `goldCap`, `durabilityTick`, `rolledMods`,
   `repairAllCost`/`repairAll`, `currentStock`/`buyback`. Serialise it — have
   the second agent report the row and write it yourself.
3. **Only one agent may hold `src/main.js` at a time.** M3 registers two new
   subsystems — `items` (ITEM-1) and `save` (SAVE-1). Each gets the O-12
   two-line permission by name, and they never run concurrently.
4. **Only one agent may hold `src/dev/shots.js` at a time** — ITEM-15 and UI-6
   both want to register a shot.
5. **Only one agent may hold `tools/check-imports.mjs` at a time** — `src/save/`
   has to become a root (§4.4).

**And verify serially.** Two agents may be *writing* at once; you run `npm test`
against one landed change at a time. A green suite containing two unverified
tickets tells you nothing about either. M1 measured what concurrency does to the
perf stage — the same test failed ~1 run in 9 idle and 2 in 4 with one subagent
running alongside. **Do not run the acceptance suite while a subagent works.**

### 3.5 Spec slices

Verify each heading with `grep -n` before slicing — line numbers drift, headings
are authoritative.

```bash
# 04-items.md — the spine of this milestone
#   §1 bases L63-427, §2 affixes L428-679, §3 rare naming L680-807,
#   §4 quality roll L808-1014, §5 treasure classes L1015-1255 (§5.8 ground L1236),
#   §6 uniques L1256-1493, §7 economy L1494-1764 (§7.4 durability L1593,
#   §7.5 vendor L1634), §8 potions L1765-1866,
#   §9 THE GENERATION ALGORITHM L1867-2065 (§9.2 draw order L1883-1910),
#   §10 lootsim L2066-2191 (assertion ids L2099-2122), §11 icons L2192-2310,
#   §12 implementation order L2311-2339, §14 deviations L2384-end
awk '/^### 9\.2 The draw order/,/^### 9\.3/' docs/spec/04-items.md

# 09-ui.md: §4 HUD L787-1098, §5 tooltip L1099-1427, §6 inventory L1428-1607,
#           §7 icons L1608-1789, §10 feedback L2017-2194,
#           §13 performance L2465-2588, §15 implementation order L3068-3097,
#           §16 API additions L3098-3179
# 01-data-model.md: §5 items L733-959, §10 save schema L1494-1672
#           (§10.3 invariants: header L1612, rows L1614-1628 — FIFTEEN),
#           §11 object pools L1673-1751
# 02-api-contracts.md: the `items` draw order ≈L1461-1487
# 12-testing.md: §5.3 lootsim L358-372, §7 determinism L461-489,
#           §9.1 the shot set L529-548, §11 milestone gates L612-636
# 03-combat-math.md: §4.6 reference weapons L350-364   (ITEM-1's cross-check)
# 13-progression-lore.md: §2.4 invariants 16-17 L493-499, §10 naming pools
#           L1433-1736 (§10.3 pools L1471)                (ITEM-8, SAVE-1)
```

## 4. Standing constraints carried into M3

Each was paid for in M0, M1 or M2 and is recorded in `PROGRESS.md`. Put the
relevant ones **into the brief of the ticket they bind**, by name.

### 4.1 Performance rules found by measurement (all tickets)

- `Math.hypot` allocates — 5.73 B/call vs 0.34 B for `Math.sqrt(x*x + y*y)`.
  Banned in anything marked `Alloc = no`.
- `Map` leaks on never-repeating keys (~456 B/call) even when live entries stay
  at one. `Map.prototype.clear()` allocates unconditionally. Use index
  arithmetic or parallel typed arrays for pooled or recycled state. **This binds
  M3 harder than any previous milestone**: container occupancy, the ground-item
  registry, the icon cache and the recent-name ring are all exactly the shape
  that tempts a `Map` keyed by a monotonic `uid`.
- `array.length = 0` tears the backing store; the next write reallocates.
- Template strings in a hot path allocate — O-59 caught `buildAttackPacket`
  building ten of them per call. Watch for the same shape in affix-key lookup
  and icon cache keys.
- **A time-based criterion hides an abort.** M1's most expensive lesson: NAV-2
  met "≤ 1 ms" by refusing to work. Wherever a criterion measures time, pair it
  with a criterion on **work actually done**. In M3 this binds **TEST-7**
  ("under 20 s" — also assert every configuration actually ran and consumed its
  full sample count) and **ITEM-15** ("p95 ≤ 1.2 ms" — also assert all 305
  renders happened and produced distinct bitmaps).
- **O-43/O-23: allocation probes need N ≥ 1 000 000.** `12.A01`'s "10 000" is
  the spec's lower bound, not a working N — on correct, genuinely
  allocation-free code the mean decays 80.45 → 17.88 → 0.391 → 0.325 B/call as
  N goes 10k → 100k → 1M → 4M. Fix by lengthening the warm-up, never by
  loosening the threshold; distinguish a real leak by watching **total** bytes,
  not the mean.

### 4.2 The rulings — settled, binding, brief from these

Ten blockers, ruled on 2026-07-30 and recorded as **D-19…D-28** and **O-60** in
`docs/PROGRESS.md`. Each entry below gives the ruling, enough reasoning to put in
a brief, and what the affected tickets must do. **Verify each against the files
before you use it — do not re-open it.**

**⚠ Naming collision, read this first.** `04-items.md` §14.1 numbers its own
deviations `D-1`…`D-11` and they are **unrelated** to `PROGRESS.md`'s
`D-1`…`D-28`. In every brief, cite them as `04 §14 D-n` versus `PROGRESS D-n`.
Both documents have a "D-7" and they say completely different things.

---

**1. The draw order — `04` §9.2 (`D1`–`D15`) is normative. [D-19]**

`02-api-contracts.md` (≈L1461) gives a twelve-row table and calls it
contractual; `04-items.md` §9.2 (L1883–1910) gives fifteen draws. `04` wins, for
three reasons worth repeating to a subagent:

1. `04:1869` declares itself "the normative description", and §10 of the same
   document *is* the specification of `tools/lootsim.mjs` — so `04` sits
   upstream of the harness that reproduces the order.
2. `04` carries labelled, reasoned deviations `02` never absorbed: `04 §14 D-2`
   (the base pick is two draws, group→base), `D-6` (quality is one cumulative
   ladder draw), `D-10` (a third name word). None of them asks for `02` to be
   updated, which is what a stale table looks like.
3. **`02` describes a mechanic the data model does not have.** Its row 2
   ("treasure-class pick, recursive, one draw per level of nesting") has no
   counterpart at all: `resolveTC(family, mlvl)` (`04:1042–1054`) is a
   deterministic band-suffix lookup — **zero draws, no nesting**. Its row 1
   (`nodrop` as a separate always-taken draw) is likewise a phantom: `nodrop` is
   one weighted entry of `entries`, resolved by the same `D1`.

Two further divergences nobody had noticed, and both must reach the briefs:
**a rare's affix count is TWO independent draws** (`D9b` prefixes, `D9c`
suffixes — `04` §9.6), not `02`'s single draw; and **there is no recent-name
ring in `04`** (its §3.5 tolerates repeats — but see ruling 8, where the ring
wins anyway, from a third document).

The five-step macro-order of `ARCHITECTURE.md` is undisputed and preserved by
both.

**The one genuine fork, and how it was decided.** Ground scatter: `02`
(L1481–1483) says the two draws are **taken and discarded** even when the item
never reaches the floor; `04:1881` states the opposite general rule ("a draw
that is skipped is **not** consumed"). This is the only place the two documents
give *opposite* answers rather than one being silent. **`02`'s rule wins** —
it is the only one under which a `lootsim` histogram is independent of who
called `rollDrop` and whether the item landed. ITEM-9 implements
take-and-discard explicitly.

*Tickets:* **ITEM-5** implements `D3→D4→D5→D7→D8`; **ITEM-6** implements `D9a`
(magic, one draw) versus `D9b`+`D9c` (rare, two draws) → `D10` → `D11` and must
not collapse the rare count; **ITEM-7** `D12`; **ITEM-8** `D13`; **ITEM-9** the
nodrop-folded-into-`D1` model with no recursive TC descent, plus the explicit
scatter discard; **TEST-7** instruments the tag sequence against `D1`–`D15`.

*Spec edits (whoever reaches them first, not you):* `12-testing.md:475` reword
`12.D08` to cite `04` §9.2; `02:1461–1487` mark superseded; `ARCHITECTURE.md`
:261–262 redirect; `04` §9.2 add the discard rule at `D15`; `BACKLOG.md:158`.

---

**2. `lootsim` runs six profiles, not 36 configurations. MF 400 does not exist. [D-20]**

`04` §10.1: six profiles (`early`/`mid`/`late`/`champ`/`boss`/`sweep`), 200 000
drops each, **1 200 000 total**, under 20 s. `12` §5.3's "three difficulties ×
three ranks × four MF values (0, 50, 150, 400)" is stale. Why `04` wins:

1. `12-testing.md:281` — `12`'s own harness-ownership table names `04-items.md`
   §10 as this tool's owning document. `12` defers to `04` by its own text.
2. `12` §5.3 **contradicts itself two paragraphs later**, referring to "the same
   200 000 drops" and "the ledger at clvl 5 / 15 / 28" — and clvl 5/15/28 is
   exactly `early`/`mid`/`late`. That is profile language, not grid language.
3. Budget: six profiles is 1.2 M drops against a 20 s bound. The grid reading is
   7.2 M — six times the volume, roughly two minutes. The 20 s was calibrated
   against the profiles.

**MF 400 is unreachable.** `04` §4.2 ("Caps") computes the whole catalogue's
maximum as `38 + 38 + 38 + 14 + 14 + 30 = 172 %`. The stat's engine cap is 1000,
but no legal gear in M3 or later exceeds 172 %. An MF-400 cell would assert a
state the itemisation system cannot produce.

**And `04.G01` / `04.G02` are correct — this is not a defect.** `12-testing.md`
§3 "Assertion identity" (L113–145) fixes the convention: the full id is
`<document number>.<id>`, numeric parts zero-padded to two digits, and the bare
form is legal **only inside the owning document**. So `04` §10.2 writes `G1`/`G2`
legitimately, and `12` referencing them from outside as `04.G01`/`04.G02` is that
same rule — identical to `03.E01`–`03.E14` for bare `E1`–`E14`. Nothing to
normalise. (Earlier drafts of this prompt said otherwise; they were wrong.)

Minor: `04:2092` says "under 20 s", `12:281` says "15 s". Keep 20 s.

---

**3. The weapon table stays split; `equipment.mainHand` is an `ItemInstance`. [D-21]**

`src/combat/data/weapons.js` **stays exactly as it is, permanently** — it is the
frozen calibration fixture behind the fourteen worked examples, i.e. the M2
gate. `03` §4.6 says so itself: "the full base catalogue belongs to the items
specification; **these seven rows are fixed here**". Merging or re-exporting
would also make `combat` import `items`-owned data, which `ARCHITECTURE.md`
rule 2 forbids even for pure data.

`actor.equipment.mainHand` carries the literal `ItemInstance | null` of `01`
§5.4, **not** a flat weapon profile. This is forced, not chosen: an
`ItemInstance` has `rolls.damageMin`/`damageMax` — different names — and no
`attackTime` or `handling` **at all**; those live on `ItemBase`, reachable only
through `baseId`, which only `items` may resolve. Redefining `mainHand`'s shape
for combat's convenience would break every other consumer (tooltips, save
serialisation, `items.weaponOf`, vendor).

So **ITEM-11** maintains a derived view — `_cache.weapon = { minDamage,
maxDamage, attackTime, handling }`, on the `_cache` that `01` §5 already defines
as derived, non-serialised and rebuilt on load — and **ITEM-11 also makes the
one-function amendment to `resolveWeapon`** in `src/combat/packet.js`,
discriminating on `baseId`: present → real `ItemInstance`, read `_cache.weapon`;
absent → a flat `03` §4.6 fixture, return as-is.

**M2 gate impact: none, verified by running it.**
`node --test tests/combat/examples.test.js` is green 14/14, and `WEAPONS.*`
records carry `id` and never `baseId`, so every E01–E14 fixture takes the
existing branch byte-for-byte. Require ITEM-11 to carry its own acceptance line
on keeping `_cache.weapon` in sync with every path that changes
`rolls.damage*` or swaps `baseId` — a missed write path silently falls back to
`unarmed` for a geared player, which is O-55 again as a stale-cache edge case.

**O-55 half-closes.** The player's gear now flows correctly through
`buildAttackPacket`. Monsters still carry no `ItemInstance` and will not until
the bestiary is itemised, so the monster half is **carried to M5 (AI-3/AI-6)**,
and AI-2's sanctioned `combat.scratchPacket()` bypass (`02` §8) stays correct
until then. Say this explicitly in the gate report so ITEM-11 landing is not
mistaken for O-55 closing.

---

**4. `inventory_full` is blessed partially; `vendor_open` defers to M6. [D-22 / O-60]**

`12` §9.1 pins both to M3. Neither is fully reachable: the paperdoll is UI-10
(**M4**), the vendor panel is UI-12 (**M6**), and "enter the baseline" in `12`
§9.1's sense means `tools/baseline.mjs` — **TEST-15, M9**.

`inventory_full` is captured and committed in M3 **under the same name**, as the
two-thirds M3 owns: the populated grid plus a rare tooltip with live comparison.
**UI-7** registers it in `src/dev/shots.js` and blesses it with
`node tools/capture.mjs --bless --shot inventory_full` — exactly how
`boot_clean` and `ui_clean` were blessed; `baseline.mjs` is not needed for a
first baseline. UI-10 extends the same `setup` and re-blesses it in M4, which
`12` §9.3 explicitly sanctions as the point of the gate.

**The `description` string in `shots.js` must state what the frame does not yet
contain and who adds it.** This is not decoration: O-50 happened precisely
because a shot promised content its frame did not show.

`vendor_open` is **not touched in M3** — zero of its two named elements exist.
It moves to M6 alongside `town_overview` / `altar_arena` / `boss_phase_2`.

---

**5. `player.hudState()` gets a new micro-ticket, PLYR-10. [D-23]**

`09` §15 U1 drives the plinth from `player.hudState()`. The method exists in no
file and no ticket — **but the contract does**: `02-api-contracts.md:1199–1213`
carries the complete `HudState` literal, and `ui.debugState(...)` is at
`02:1301`. The hole is in the backlog, not the spec: nobody owns *writing* the
aggregator.

Two escape routes are closed by rule, not by taste. `09` §D-A states that once
per `lateUpdate` `ui` calls `player.hudState(this._hud)` and "that is the
**only** path by which a persistent value reaches the HUD" — so UI-2 reading
`ctx.get('actors')` directly is a violation. And widening UI-2 to write inside
`src/player/` violates `ARCHITECTURE.md` hard rule 1.

**PLYR-10 — "HUD state aggregation", `src/player/index.js`** — is therefore
created, scheduled **before UI-2**. Reopening a closed file is normal here
(UI-7 does the same to UI-5's `tooltip.js`). It fills life / mana / secondary
from the actor record (ACTR-7/ACTR-8, merged) and uses **the contract's own
defaults** for fields whose systems arrive in M4/M6 — `hotbar`, `cooldowns`,
`xp*`, `gold`, `questStep`. Those defaults are in the literal for exactly this
reason. U1's acceptance is unaffected because `ui.debugState('combat')` stages
its numbers deliberately rather than reading live progression.

Related: **`items.beltCooldown` belongs to ITEM-10** (whose title already says
"belt"; the 0.5 s global cooldown is `04` §8.3), and **UI-3 gains ITEM-10 as a
dependency** it did not have. `ui.debugState(...)` is built incrementally by
whichever ticket needs a mode: `'combat'` → UI-2, `'inventory'` → UI-7,
`'tree'` → UI-9 (M4), `'vendor'` → UI-12 (M6).

---

**6. File names: the spec wins eight times, and twice there is no spec name. [D-28]**

Straight application of `PROGRESS` D-7:

| Ticket | Backlog | Use |
|---|---|---|
| ITEM-4 | `src/items/roll.js` | `src/items/rng.js` + `src/items/quality.js` |
| ITEM-6 | `src/items/affix.js` | `src/items/roll.js` — collides with ITEM-5, see §3.3 |
| ITEM-8 | `src/items/name.js` | `src/items/data/names.js` |
| ITEM-10 | `src/items/container.js` | `src/items/containers.js` |
| ITEM-11 | `src/items/equip.js` | `src/items/equipment.js` |
| ITEM-14 | `economy.js` | `economy.js` **+ `vendor.js`** |
| ITEM-15 | `src/items/icon.js` | `src/items/icons/` (directory) |
| ITEM-16 | `src/items/serial.js` | `src/items/serialise.js` |
| ITEM-12 | `src/items/ground.js` | **no spec name** — keep it, recorded as invented |
| ITEM-13 | `src/items/state.js` | **no spec name** — keep it, recorded as invented |

Also corrected: **ITEM-12's Spec column** is not `04 §6` (that is Uniques) — it
is **`04` §5.8 plus the §13.1 event-table addition** (`items` listens to
`actor:damage` to reset the fresh-drop grace period).

---

**7. ITEM-15: no lint carve-out, three `maul_` bases, 305 renders. [D-24]**

**The lint.** `tools/check-imports.mjs` flags exactly four things: a bare
`three` / `three/...` import, and three regexes — `window\.`, `document\.`,
`performance\s*\.\s*now\s*\(\s*\)`. **`OffscreenCanvas` is not forbidden by
anything**, and `02:205–208` already assumes `items` constructs one itself. No
`document.createElement('canvas')` fallback is needed either: `09:1625` fixes the
icon surface as `OffscreenCanvas` with a `2d` context, full stop.

The only real conflict is `performance.now()` for the p95 measurement, and it is
removed by **putting the timing outside the strict root** — an established
pattern here, not an invention: `src/nav/flow.js` and `src/nav/astar.js` do not
time themselves for exactly this reason, and `tools/profile.mjs` wraps them from
outside. ITEM-15's timing driver lives outside `src/items/`, runs the 305 calls
in headless Chromium (Playwright is already a devDependency and already used by
`capture.mjs`), and times them with **the page's own** `performance.now()` —
which is never scanned, because the lint only walks `src/`.

A D-13-style carve-out is **not** granted and not needed. D-13 exists because
`three` inside `src/actors/` is physically unavoidable — somebody must construct
a real `SkinnedMesh`. Here nothing forbidden is required at all, so weakening
`items`' N-surface guarantee would buy nothing.

**The recipes.** The `mace` recipe selects `mace_` and `hammer_` and therefore
misses the `maul_` bases, which fall through to no recipe — extend the selector.
But note the spec **miscounts them**: `04` §11.3 and §14.2 C-4 both say "four
maul bases"; there are **three** (`maul_great_normal`,
`maul_ossuary_exceptional`, `maul_anvil_elite`), verified against the base
tables and `03` §4.6. Implement three and report the miscount. The `bow` recipe
stays implemented but unreachable — no `bow_` base exists anywhere (`03` §4.1
excludes bows from the player set) and §11.3 itself recommends keeping it for
post-M9 content.

**305, not 192.** 305 = 61 equipment bases × 5 rarities (`RARITY_ORDER`, `01`
§1), which is `04` §12 step 11's binding acceptance, with p95 ≤ 1.2 ms /
p100 ≤ 2.0 ms measured against the heaviest recipe `armour_sepulchre_elite`
(`04` §11.2). **192 is the LRU cache capacity** from `09` §7.1, reused in U6 as a
round number for a coarse aggregate check. They are compatible; 305 binds.

**`ui_icons` is dev-only.** It is not among `12` §9.1's twelve pinned shots.
ITEM-15 registers it (icons belong to `items` — `ARCHITECTURE.md:104`, and
`09:3093` agrees), following the `actor_ranker` / `actor_walk_phase*` precedent:
**never blessed into `tests/fixtures/shots/`**, verified by two `capture.mjs`
runs being byte-identical.

---

**8. Rare names come from `13`, with the 64-ring. [D-25] — the largest ruling**

Counted by hand: `04` §3.2/§3.3 hold **44 heads × 48 tails** (consistent with its
own `D13` ranges `Ui(0,43)`/`Ui(0,47)`); `13` §10.5 holds **56 × 48**. These are
not a typo apart — they are **two complete, independently authored word lists**
for the same feature, barely overlapping lexically.

**`13` wins.** It actually solves Russian case agreement (rule G3: gender tags on
heads, pre-inflected genitive tails), whereas `04` claims no agreement machinery
is needed and then **contradicts itself with its own worked example** — "Рок
Погибели" (genitive) against a tail table that yields "Погибель" (nominative).
`13` §10 also names ITEM-8's exact target file, and `13` §14 is the document that
reconciles cross-spec conflicts wholesale.

**The 64-entry ring is in scope**, and it does not break `N2` arithmetically.
With pool 2688, ring 64, n = 100: of C(100,2) = 4950 pairs, 4284 are protected by
the ring, leaving 666; expected collisions ≈ 0.248, so P(at least one) ≈ **21.9 %**
— far under `N2`'s 75 % ceiling. What the ring breaks is `04` §3.5's *design
narrative* ("past 70 rares a repeat becomes likely, which is the correct place
for the illusion to break") — and the ring exists precisely to prevent that.

*ITEM-8 therefore:* ships `13`'s 56 × 48 pools with gender tags and
pre-inflected tails; draws `Ui(0,55)` / `Ui(0,47)`; implements the ring;
**drops the three-word epithet mechanic of `04 §14 D-10`** — in the adopted
system a rare name is always two words, and `13`'s epithet pool belongs to
unique *monsters*, a different feature. `N1` becomes "every rare name is exactly
two words"; `N2` becomes the ring invariant as a hard fail plus a recomputed
statistical ceiling (~22 % expected, 35–40 % a sane bound) instead of citing the
void 69.4 % prediction.

---

**9. Eight uniques. [D-26]**

`04` §14 C-1 asks whether the count or the coverage was the intent.
**Eight, as shipped in `04` §6.** `IMPLEMENTATION_PLAN.md` §4.4 says "Уники MVP
(**8 штук**)" and then glosses it "one per slot plus two weapons" — but `01` §1.5
defines **ten** slots, so the gloss yields 12 and contradicts the number in its
own sentence. The plan settles it by repeating "8 уникальных предметов" in its
milestone table for M7, and `04` §6.10 documents the uncovered
`ring1`/`ring2`/`offHand` as a deliberate trade-off deferred to "after M9". No
ticket to build the missing four exists anywhere in the backlog — ITEM-17 is
tiers, ITEM-18 is Magic Find. `U1` stays "exactly 8". `04 §14 D-11` (no ring or
shield unique) stands.

---

**10. SAVE-1 implements invariants 1–15; `hammerfell_brute` was already
resolved. [D-27]**

`01` §10.3 lists exactly **fifteen** invariants, and invariant 4 is already in
its amended form there (`− Σ classStartSkills`, per `13` §14 C5, no version
bump). Invariants **16 and 17** come from `13` §2.4 and both validate quest
state: 16 needs `definition.steps.length` from `src/player/data/quests.js`
(**PLYR-5**), 17 needs `reward.skillsAll` (**PLYR-9**). Both are M6. SAVE-1's
only dependency is ITEM-16.

So SAVE-1 in M3 implements **1–15**. The `quests` and `questSkillPointsGranted`
fields already exist in the save shape — what is missing is the data the
validation logic needs, not the shape. This is consistent with SAVE-2
(localStorage) and SAVE-3 (migrations) also being M6: SAVE-1 in M3 is schema and
`validate()` over fixtures, with no live persistence loop. All seventeen are
asserted together by `tools/save-fuzz.mjs` (TEST-10, M6), which is also where
ITEM-16's 10 000-item round-trip lives — do not let ITEM-16 try to build M6's
tooling.

**Also closed here: `04` §14 C-3 is stale, not open.** `06-monsters-ai.md` §15
D-2 already ruled "Chosen: `maulsmith`", `13` §14 C2 confirms "Applied",
`07-world-gen.md` already uses `maulsmith` in its live array, and
`src/ai/data/bestiary.js` (shipped in M2) has no `hammerfell_brute` key at all.
There is no seventh archetype; ITEM-3's `tc_heavy` → `maulsmith` stands.

### 4.3 Per-ticket bindings

| Ticket | Must be told |
|---|---|
| ITEM-1 | 75 is a hard count; every `id` and `iconSeed` unique. The seven weapons of `03` §4.6 are cross-checked against a second document — reproduce the numbers, do not re-derive them. `ARCHITECTURE.md` rule 9: this is `data/`, flat and headless, no logic. `04 §14 D-1`, `C-6`, `C-7` |
| ITEM-2 | Every `mods[].stat` must be one of `01` §3's 92 identifiers — assert against a **literal list**, not against whatever `StatBlock` happens to expose today. A typo here surfaces in M4 as a skill that does nothing. `04 §14 D-5` |
| ITEM-3 | Every non-boss class sums to **exactly** 1000. Not "approximately", not "after rounding" — a class summing to 999 shifts every rarity in it and lootsim reports it as a tolerance failure three tickets later |
| ITEM-4 | The `items` fork is taken **once in `init()`** (`ARCHITECTURE.md` rule 4). **This is the first new fork since `combat`'s and it will meet `tests/core/boot.test.js` — see O-36/O-54 in §4.4.** `rollQuality` consumes exactly one draw, proven with a counting `Rng` wrapper, not by reading the code. Tolerance is lootsim's **R1**, not the backlog's 0.05 pp — the backlog is 6–20× tighter than R1 and not attainable at 10⁶ draws. `04 §14 D-6`, `D-7` |
| ITEM-5, ITEM-6 | Same file. The second is told by name what the first left. The draw order is the point of both: a correct total with a different draw sequence is a **rejection**, because `12.D03`'s byte-identical histogram depends on the sequence, not the sum |
| ITEM-6 | `sharedRoll` draws **once** and writes every entry — the precondition for `09` §5.3's all-resistances merge, which UI-5 asserts. One group never appears twice. Full assertion set is A3–A8 **and** R3, not the two the backlog names |
| ITEM-7 | `04 §14 D-3` (base substitution), `D-4` (five mods on `ashen_crown`), `D-11` (no ring or shield unique), and `C-1` is open — if the owner has not answered, implement the eight §6 ships and flag `U1` |
| ITEM-8 | Ruling 8 in full, and it is the largest ruling in the milestone: the pools come from **`13` §10.3/§10.5 (56 × 48)**, not `04` §3.2/§3.3 (44 × 48); draws are `Ui(0,55)`/`Ui(0,47)`; the **64-entry ring** is in scope; **`04 §14 D-10`'s three-word epithet is dropped** — a rare name is always two words |
| ITEM-9 | The largest single ticket in M3. Expect two rounds. Ground scatter's two draws are taken **and discarded** when an item is created straight into a container — skipping them must not shift the stream. `04 §14 D-8` |
| TEST-7 | `tools/` is lead-owned (`ARCHITECTURE.md:112`) — grant `tools/lootsim.mjs` explicitly and say nothing else under `tools/` is in scope. **Do not narrow the assertion set to make it green**: O-58 is the precedent, where TEST-6 quietly dropped one method from `12.A01`'s list and the check read as full coverage while it was not. If a configuration cannot run, say so; do not skip it silently |
| ITEM-10 | Property tests, not examples. The backlog names one of the spec's five; brief all five, plus `autoPlace`, `itemAt`, `splitStack` and `sortContainer` (required by `09` §16.2, promised by no backlog row). No `Map` for occupancy (§4.1) |
| ITEM-11 | `canEquip` must never let an item satisfy its own requirement — the classic +STR ring that lets you wear itself. Two-handers refuse without room for the displaced off-hand. **This is where `items` and `actors` actually meet**, via `setSourceLayer(actor, 'equipment', …)`; O-48 is the warning — in M2 an entire stat layer was built and never consumed. Also owns `slotsFor`, which UI-7 needs |
| ITEM-13 | `04 §14 D-9` fixes the rates and the failure mode: 0 durability is **`unusable`, not destroyed**. `durabilityTick` emits `stats:dirty` at 0; `identify` reveals affixes **and** emits. Both are contract rows in `02` §11. `beltCooldown` is **not** yours — D-23 gives it to ITEM-10 |
| ITEM-15 | Ruling 7 in full: no lint carve-out (timing lives outside `src/items/`, `nav`-style), `maul_` added to the `mace` selector with **three** bases not four, `bow` kept unreachable, **305** renders binding, `ui_icons` dev-only and never blessed. `04` §11.2: the 1.2 ms budget is measured against `armour_sepulchre_elite` |
| ITEM-16, SAVE-1 | `01` §5.3's field list is exhaustive plus `uniqueValues`. An older save without `uniqueValues` defaults to `[]` and the unique reads as its minimum values — the safe direction, and it must stay that way. SAVE-1 asserts §10.3's fifteen, including the amended invariant 4; 16–17 land in M6 with PLYR-5/PLYR-9 (ruling 10). `save-fuzz` is M6's |
| UI-2…UI-7 | `09`'s hard rule: everything animates by integrating `dt` in `lateUpdate`. **No CSS transitions** — they make the pixel gate non-deterministic, which `12` §9.2 says the gate cannot survive. The eight layer nodes already exist in `style.js`; attach into them, do not restructure. The DOM node budget (`09` §13.1) is a measured assert, not advice |
| UI-4 | Pooled: ≤ 3 live per target, ≤ 24 drawn per frame, coalesced at 0.12 s, **no allocation after the first frame**, pool built in `init()`. Measure with `tests/helpers/alloc.js` — the spec's `tools/profile.mjs` is TEST-14, **M9**, and does not exist |
| UI-5, UI-7 | Same file, sequential. UI-5 must **not** implement comparison — that is UI-7, and a UI-5 that "helpfully" adds it makes UI-7 a rewrite. UI-5 owns tooltip **placement** (the degradation ladder, four-corner containment, never covering the cursor), which the backlog dropped entirely |
| every ticket | **O-12**: a ticket registering a new subsystem may add exactly two lines to `src/main.js` — its `import` and its `registry.add(...)`. Nothing else. Grant by name (M3: ITEM-1, SAVE-1) |
| every ticket | **O-27 / O-39**: a test written before a subsystem encodes "nothing exists yet". It has bitten six times, most recently `boot.test.js` in M2. Never assert counts of subsystems, bodies, items or exact pixels, and never write `typeof x.method === 'undefined'`. Assert the behaviour the test exists for |
| every ticket | A public method exists only if `02-api-contracts.md` lists it, **with its `Fixed` and `Alloc` columns**. Adding one means adding its row in the same ticket. Not automated — **you** are the check: diff the table against the new public surface at acceptance |
| every ticket | Any new method whose contract row says `Alloc = no` must be **added to `12.A01`'s probe list**. O-58 exists because a method was excluded from the list instead of fixed |

### 4.4 Open debts entering M3

Assign each to a named M3 ticket in your first report, or tell the owner plainly
it is carried to M4. Do not let them drift.

**Newly live because M3 touches them:**

- **O-36 / O-54 — `tests/core/boot.test.js` and the RNG snapshot.** The test now
  captures `ctx.rng`'s state in a stub that runs *after* `combat`'s fork and
  compares it at the end of boot. ITEM-4 takes the `items` fork and SAVE-1 may
  take another; depending on init order relative to that stub, either falsifies
  the snapshot. This is O-27's seventh appearance waiting to happen. Bind the
  re-check to **ITEM-4** and grant it the file explicitly if it must edit it —
  the way UI-1 was granted it in M2.
- **O-58 — `combat.expireBySource` allocates 3.47 B/call against a contractual
  `Alloc = no`.** Owner CMBT-4. It blocked M2's gate item ⑤ and was to be fixed
  at the source, not by narrowing the list. **Verify it is actually fixed**
  before you lean on `12.A01` in M3's gate item ⑩.
- **O-59 — `buildAttackPacket` builds ten template-string keys per call.**
  Contractually `Alloc = pool`, so it blocks no gate, but it is on the hot path
  and M3 is when items start feeding that path. Micro-repair candidate for
  whoever touches `packet.js` over ruling 3.
- **O-48 — `instance.statMods` is built and never consumed.** ITEM-11 is the
  first ticket to write a real stat layer. If `composeStats` still does not read
  the `status` layer, say so — do not let a second unconsumed layer land beside
  the first.
- **O-55** — settled by ruling 3: **half-closed**. ITEM-11 fixes the player side; the monster side is carried to M5 (AI-3/AI-6) and must be reported as such at the gate, not quietly counted as closed.

**Carried, and still nobody's:**

- **O-40** — `src/physics/separate.js` reads `performance.now()` inside the fixed
  step and `check-fixed.mjs` cannot see it (its model is "a method named
  `fixedUpdate`", narrower than the rule). `src/physics/` is consequently still
  on `checkGlobals: false`. A determinism hole; M3 has no physics ticket, so
  carrying it is a decision, not a default.
- **O-37** — the static grid is re-hashed twice on a zone change.
- **O-53** — `actor:damage` (R14 k) is emitted before the R14 (d)/(f) credits,
  against `03` §6.2's fixed order. Harmless today, ugly in M4.
- **O-57** — `ActorsSystem` does not expose `stats` / `composeStats` /
  `beginAction` / `applyStatus`, so the action machine and attack timings are not
  wired into the integration path. **ITEM-11 needs `setSourceLayer` on that same
  object.** If it is still not exposed, that is an owner question, not a
  workaround.
- **O-52, O-49, O-47, O-46, O-45, O-35** — read their rows; none binds an M3
  ticket, and each should be re-affirmed as carried or closed.

### 4.5 Tooling traps (yours, when verifying)

- **O-26**: `tools/capture.mjs` does **not** rebuild `dist/`. Always
  `npm run build` first, or you bless a frame from stale code.
- **O-50 is fixed** — `shot.setup` now runs inside the page (ACTR-6). Every
  scene-content shot in M3 depends on that fix; if a new shot comes back
  byte-identical to `boot_clean`, suspect `setup` before you suspect the renderer.
- **O-20**: `--test-name-pattern` must come **before** the glob, and the glob must
  be quoted. Flag after glob silently filters nothing.
- **O-28**: `tests/tools/capture.test.js` boots `vite preview` + Playwright at
  file level, so it runs even under a name filter. Target a directory
  (`tests/items/`) when you want a fast, focused run.
- The perf stage is `--test-concurrency=1` and takes ~114 s. A new file joins it
  by being named `*.perf.test.js`. If a test flakes, the fix is isolation or the
  perf stage — **never** a retry, never a loosened threshold.
- **Only `boot_clean` and `ui_clean` are blessed.** The four `actor_*` shots
  render but have no committed fixture; do not treat their output as a baseline.

## 5. The loop, one ticket at a time

For each ticket in the order of §3.2, subject to §3.4's lane rules:

**5.1 Confirm readiness.** Deps closed? Owned files free of any concurrent
agent? If the previous ticket is not accepted, you do not start what depends on it.

**5.2 Build the brief.** Extract only the named spec sections. Target
**1500–4000 lines** of context per ticket. Materially more means you took a whole
spec — reread the Spec column. For ITEM-5, ITEM-6 and ITEM-9, `04` §9.2's
draw-order table goes in **verbatim**: the agent should be transcribing the
order, not deriving it.

**5.3 Spawn one Sonnet 5 subagent.** One ticket, one agent, named after the
ticket:

```
Agent(
  name: "ITEM-9",
  description: "rollDrop end to end",
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

<only the named sections, extracted from docs/spec/*.md. For any ticket on the
drop path, include 04 §9.2's draw-order table verbatim. Include the relevant
04 §14 deviations by number — they override the body of the document.>

## Project state you must respect

<the relevant rows from §4: performance rules, the ticket's own O-nn / D-n
entries, the resolved file-name and criterion corrections, the main.js two-line
permission if it applies>

## Rules

1. You own only the files listed above. Editing any other file is a defect and
   will be reverted. If you need someone else's file, say so in the report —
   do not edit it.
2. No new dependencies. `three` only, and gameplay/math code must not import it
   at all. `src/items/` and `src/save/` run headless in Node: no `three`, no
   `document`, no `window`, no `performance.now()`, transitively.
   `tools/check-imports.mjs` enforces this and it already covers `src/items/`.
3. No `Math.random()`. Use `ctx.rng` or your own `ctx.rng.fork()` taken once in
   `init()`. Draw order is contractual — see the spec slice.
4. Simulation lives in `fixedUpdate` (60 Hz) and never reads `dt` or the wall
   clock, including `performance.now()`. Presentation lives in `update`.
   Schedule against `ctx.time.step`.
5. Zero allocation per frame. Vectors, pools and scratch buffers are built in
   `init()`. `Math.hypot` is banned — use `Math.sqrt(x*x + y*y)`. `Map` is
   banned for recycled or pooled state, including container occupancy and any
   cache keyed by a never-repeating id. Template strings in a hot path allocate.
6. Gameplay numbers live in `data/`, not in code.
7. A public method exists only if `docs/spec/02-api-contracts.md` lists it, with
   its `Fixed` and `Alloc` columns. If you need a new one, say so in the report
   and wait — another agent may be holding that file. Do not invent API
   silently.
8. `npm run build` must pass and `npm run capture` must still produce a frame.
   Breaking the boot blocks every other ticket.
9. Do not write tests outside your ticket and do not touch fixtures or blessed
   PNGs. A test that asserts a time, an allocation or a frame goes in a file
   named `<thing>.perf.test.js` so the runner isolates it.
10. Git: no commits, no pushes, no branch operations. And specifically: no
    `git stash`, `checkout`, `restore`, `clean`, `reset`. Another agent may be
    working in the tree right now. Need a file out of the way? Rename it.
11. Do not assert "nothing else exists yet". Counts of subsystems, bodies, items
    and exact pixels all change every milestone; assert the behaviour your test
    exists for. A test whose truth depends on the next ticket not existing is a
    defect, not coverage.
12. If your criterion is a time budget, also prove the work was done. A harness
    that meets its budget by running fewer cases does not pass.

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
2. **The ticket's own criterion.** The exact command from the corrected
   "Done when". If it is an assertion id (`12.D03`, `12.D08`, `G1`, `B1`, `A3`),
   run the harness that produces it — do not settle for "the file exists".
3. **The distribution, by hand, for every ticket on the drop path.** Open the
   relevant ladder in `04` §4/§5/§6, pick two cells the agent did *not*
   highlight, and check them against the implementation's own histogram. This is
   M3's equivalent of M2's "re-derive two intermediates by hand". A rarity split
   is the cheapest thing in this project to get subtly wrong and the most
   expensive to notice late.
4. **Tests.** `npm test`, both stages. For perf- or GC-sensitive tickets run it
   more than once, and never while a subagent is working (§3.4).
5. **Lint.** `npm run lint`. Cheapest guard against the most expensive mistake:
   a DOM global or `three` leaking into headless code kills the whole Node test
   surface — and in M3 that surface *is* the gate. Confirm the root count rises
   as `src/items/`, `src/items/data/` and `src/save/` come live (12 at the end
   of M2).
6. **Read the diff.** `git status --short`, then `git diff` over the ticket's
   files. Six things tests do not catch:

   | What | How you catch it |
   |---|---|
   | edits outside the owner directory | `git status --short` shows extra files |
   | importing another subsystem directly | `grep -rn "from '\.\./\(actors\|combat\|nav\|world\|physics\|ui\)" src/items` — must be empty; everything goes through `ctx.get()` |
   | `Math.random()` | `grep -rn "Math.random" src/` — exactly one legal hit, in `src/main.js` |
   | allocation in the frame | array/object literals, template strings and `Map` inside `update`/`fixedUpdate` or any `Alloc = no` method |
   | wall clock in the fixed path | `grep -n "dt\|performance.now" <file>` inside `fixedUpdate` — see O-40 |
   | gameplay numbers hard-coded | magic constants where the spec says `data/` |

7. **Independent behavioural probe.** Do not just rerun the subagent's test —
   write your own throwaway check in the scratchpad and compare. M0 rejected four
   tickets this way, M1 two, M2 several. **M3's highest-value probe is a counting
   RNG wrapper**: wrap `ctx.rng`, log a tag per draw, run one `rollDrop`, and read
   the tag sequence against the contract. It catches draw-order defects that every
   distribution test in the world will pass.
8. **Frame.** `npm run build && npm run capture`, then `imagediff` against the
   blessed baselines. `boot_clean` and `ui_clean` stay at `diffPixels=0` until
   UI-2 lands; after that `ui_clean` legitimately changes, and when it does,
   **look at the PNG with your own eyes** before blessing, and record in the
   journal that you did. M1's journal notes a frame that did *not* change when
   the prompt predicted it would — check, do not assume, in both directions.

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
`ID | date | files | verified how | notes`. A subagent's report is not a row —
your own verification is.

Keep the rest of the document alive too:

- new interface questions go into the O-table with an owner ticket;
- a question you resolve gets its resolution written down. M3 should close or
  explicitly defer **O-55, O-58, O-48**, and must record an answer for **O-36**'s
  second appearance;
- every §4.2 resolution becomes a D-entry — including the five owner answers, so
  M4 does not re-litigate them;
- a performance finding that cost someone a rewrite goes into the rules section;
- update the status line at the top and the milestone-gate table at the bottom.

The document exists so a fresh session understands the state in one minute
without rereading 180 tickets. Write it for that reader.

## 10. The M3 gate

When all 25 tickets are accepted, run the gate — and do not treat it as a
formality:

| # | Check | Source |
|---|---|---|
| ① | `npm run build` green | backlog, definition of done |
| ② | `npm test` green, **several consecutive runs**, both stages | M0/M1/M2 precedent |
| ③ | `npm run lint` green, with `src/items/`, `src/items/data/` and `src/save/` live roots | 12 §2.1 |
| ④ | **`lootsim.mjs` green over all six profiles of `04` §10.1**, 200 000 drops each (1.2 M total), completing under 20 s | 04 §10, ruling 2 — *the* M3 gate |
| ⑤ | `04.G01` / `04.G02` inside tolerance — gold per zone clear, and the ledger at clvl 5 / 15 / 28 (bare `G1`/`G2` inside `04` itself; the prefixed form is correct from outside, `12` §3) | 04 §10.2 |
| ⑥ | `12.D03` — two lootsim runs at one seed produce byte-identical histograms | 12 §7 |
| ⑦ | `12.D08` — the recorded draw sequence matches `04` §9.2's `D1`–`D15`, including the taken-and-discarded scatter draws | 12 §7, ruling 1 |
| ⑧ | End to end: an item drops, is picked up, identified, equipped, **and the `StatBlock` changes** | IMPLEMENTATION_PLAN §9, backlog M3 gate |
| ⑨ | `inventory_full` captured as its M3 two-thirds — grid + rare comparison tooltip, no paperdoll — **reviewed by eye**, committed, with an honest `description`. `vendor_open` untouched, attributed to M6 | 12 §9.1, D-22 / O-60 |
| ⑩ | M2 must not regress: `03.E01`–`03.E14` still exact; `12.A01`/`12.A02`/`12.A05` still green — **with every new `Alloc = no` items method added to `12.A01`'s list**; `ui_clean` re-reviewed after UI-2 | M2 gate |

Item ⑧ is easy to fake and easy to skip. Run it as one real scripted session —
one drop, one pickup, one identify, one equip, one stat delta — not as four unit
tests each covering a quarter of it.

Item ⑨ is easy to fudge. Say plainly which half of each shot the milestone owns.
M2's O-56 is the precedent and it is a good one.

Red gate = milestone not closed. There is no "we will fix it in M4": M4 is
skills, and every skill multiplies through the affixes this milestone is
supposed to have pinned to a distribution.

**When the gate is green, stop.** Do not start M4. Report to the owner: tickets
closed, gate results item by item, what was hard, which specs proved wrong or
ambiguous, what should be revisited in the plan. M4 starts on a direct order,
exactly as M1, M2 and M3 did.

## 11. Git

**No commits. No pushes.** Not by you, not by subagents. Take the work to
"changes are ready" and stop. The owner grants commit permission separately and
freshly each time; permission from a previous turn does not carry over. No
`rebase`, `reset --hard`, `merge`, branch or tag deletion.

**Also forbidden: `git stash`, `checkout`, `restore`, `clean`, `reset`** —
anything that touches the working tree as a whole. M0–M2 are committed, so the
blast radius is bounded, but M3's in-flight work is not, and with two lanes
running there may be two tickets' worth of uncommitted code in the tree at once.

`docs/PROGRESS.md` is the only file you write yourself.

When M3 closes, say the work is ready and offer to commit — then wait.

## 12. Stop and ask the owner when

- two documents require **incompatible** things — a contradiction, not an
  ambiguity. Everything of this kind that was known on 2026-07-30 is already
  ruled on in §4.2, including `04 §14`'s own open decisions C-1 and C-3. So this
  applies to what you find **new** — and you should expect to find some, because
  three of the nine rulings came from divergences nobody had noticed until
  somebody read both documents side by side;
- a ticket needs a **number no spec provides** — never invent one. With a
  distribution gate an invented weight is undetectable until it is expensive;
- a documented ladder does not reproduce *and* the implementation looks right.
  That is a finding about the spec, not a licence to adjust the expected value or
  widen the tolerance;
- the gate stays red after three attempts;
- something would add **game content** — a base, an affix, a unique beyond the
  eight, a monster, a skill — past the shipped lists. The plan forbids that
  before M7;
- the work would go outside the backlog.

Do not stop for routine: private function names, file layout inside your own
directory, field order. Decide and move.

## 13. Reporting

Per ticket, short:

> `ITEM-6` accepted. `src/items/roll.js`. `npm run build` green, `npm test`
> 1187/1187 across both stages, the §9.6 count model reproduces at 10⁶ draws,
> A3–A8 and R3 green, `sfx_res_all_1` writes six identical values from one draw
> (I re-checked the tag sequence with my own counting `Rng`: one draw, not six).
> Next: `ITEM-7`.

Per milestone, a table: tickets, gate results, what surfaced, what to revisit.
Do not narrate diffs. The owner tracks state and blockers.

## 14. Start here

1. Read the six items in §2 — including `04` §9 and `04` §14 in full, before
   anything else.
2. Run `npm run build`, `npm test`, `npm run lint`, `git status --short` and
   record the real baseline. You will need it to prove nothing was lost.
3. Walk §4.2 and **verify** each of the ten rulings against the current files —
   do not take this prompt's word for any of them; line numbers drift and the
   tree moves. You are checking they still hold, not deciding them again. If one
   does not hold, say so in your first report; otherwise say "ten rulings
   verified" and move on.
4. **First report, for information, not for permission:** the ten rulings
   verified (or the exception), plus what happens to O-55, O-58, O-48 and O-36
   in M3, ticket by ticket, or that they are carried. Then keep going — you do
   not wait for an answer to start ticket 1.
5. Create tasks (`TaskCreate`) for the 25 M3 tickets in the §3.2 order, so
   progress is visible.
6. Report the plan: 25 tickets, `ITEM-1` alone first, then two lanes —
   `loot: ITEM-2 → ITEM-3 → ITEM-4 → ITEM-5 → ITEM-6 → ITEM-7 → ITEM-8 →
   ITEM-9 → TEST-7 → ITEM-12 → ITEM-10 → ITEM-11 → ITEM-13 → ITEM-14 →
   ITEM-16 → SAVE-1 → ITEM-15` and
   `ui: PLYR-10 → UI-2 → UI-3 → UI-4 → UI-5 → UI-6 → UI-7` — with the UI lane
   joining the loot lane at ITEM-6 (UI-5), ITEM-10 (UI-6) and ITEM-11 (UI-7).
7. Launch `ITEM-1`.
