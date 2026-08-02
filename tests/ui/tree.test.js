// tests/ui/tree.test.js
//
// UI-9 acceptance tests for src/ui/tree.js (the `Tree` module — the skill
// tree screen) and the lines this ticket adds to src/ui/index.js
// (`_tree`, `openSkillTree`/`closeSkillTree`/`toggleSkillTree`,
// `debugState('tree')`, the `setScreen` gating). `node:test` +
// `node:assert/strict` only (12-testing.md P6).
//
// Real subsystems throughout, `sheet.test.js`'s own "full boot()" precedent
// — `SkillsSystem`/`PlayerSystem`/`ActorsSystem`/`UiSystem` all construct
// and init for real, so `skills.canAllocate()`/`describe()` under test are
// the genuine production implementations.
//
// `player.spendSkillPoint` is contracted (`02-api-contracts.md:1184`) but
// not implemented anywhere in `src/player/` (checked live; out of this
// ticket's file grant regardless — see `src/ui/tree.js`'s own file header).
// The full-confirm test below installs a TEST-ONLY implementation on the
// live `player` instance — never touching `src/player/index.js` — modelling
// exactly what the contracted method is supposed to do (check
// `skills.canAllocate`, call `skills.allocate`, decrement the tracker's own
// `skillPoints`), so this test proves `tree.js`'s own CONFIRM-ordering logic
// against something that behaves like the real method eventually will.

import test from 'node:test';
import assert from 'node:assert/strict';

import { boot } from '../../src/main.js';
import { countNodes } from '../../src/ui/util.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

async function bootAt(width, height) {
  return boot({ canvas: makeCanvas(width, height), width, height, deterministic: true, global: {} });
}

/** Models `player.spendSkillPoint(skillId) => boolean` (contracted,
 * unimplemented) on the live `player` instance for this test file only. */
function installSpendSkillPoint(player, skills) {
  player.spendSkillPoint = function spendSkillPoint(skillId) {
    const actor = player.actor;
    if (!actor || player._progress.skillPoints <= 0) return false;
    if (!skills.canAllocate(actor, skillId).ok) return false;
    const ok = skills.allocate(actor, skillId);
    if (ok) player._progress.skillPoints -= 1;
    return ok;
  };
}

/** Levels the player actor to `level` through the real path
 * (`player.grantXp` + one `fixedUpdate`, matching PLYR-4's own real
 * spawn-at-level-1 fix — see `src/dev/shots.js#skill_tree_ravager`'s own
 * header for why this is "a legitimate path"). */
function levelUpTo30(ctx, player) {
  player.grantXp(1e9, 0);
  ctx.time.step++;
  player.fixedUpdate(1 / 60, ctx);
}

const RAVAGER_IDS = ['cleaving_strike', 'bloodletting', 'whirlwind', 'bloodthirst', 'sunder', 'ram_charge', 'shield_stance', 'war_cry', 'iron_skin', 'last_stand'];
// Sums to 29 (level 30's own budget); respects `sunder`'s prerequisite
// (`bloodletting >= 3`) and every `maxLevel` cap (20).
const RAVAGER_29 = { cleaving_strike: 6, bloodletting: 3, whirlwind: 4, bloodthirst: 2, sunder: 3, ram_charge: 3, shield_stance: 3, war_cry: 2, iron_skin: 2, last_stand: 1 };

// ---------------------------------------------------------------------------
// Construction and DOM budget
// ---------------------------------------------------------------------------

test('Tree: constructs under a real boot(), panel root node count stays <= 73 (09 §13.1)', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  ui.setScreen('game');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);

  const n = countNodes(ui._tree.__nodeCountRoot());
  // eslint-disable-next-line no-console
  console.log(`[tree.test] skill tree panel node count = ${n} (ceiling 73)`);
  assert.ok(n <= 73, `skill tree panel must stay <= 73 DOM nodes; got ${n}`);
  assert.ok(n > 20, 'sanity: the panel is not suspiciously empty');

  assert.ok(ui.__nodeCount() <= 700, "09 §13.1's whole-tree 700-node cap must still hold");
  ui.dispose();
});

test('Tree: the panel root carries data-ui-solid (O-78\'s ui half)', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  assert.equal(ui._tree.__nodeCountRoot().getAttribute('data-ui-solid'), '');
  ui.dispose();
});

test('Tree: ten skill nodes built for the ravager class, matching src/skills/data/skills.js', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);

  const ids = ui._tree._nodes.map((n) => n.id).sort();
  assert.deepEqual(ids, [...RAVAGER_IDS].sort());
  ui.dispose();
});

// ---------------------------------------------------------------------------
// Connector canvas — D-39: one canvas, 780x560, redrawn only on dirty
// ---------------------------------------------------------------------------

test('Tree: connectors live on exactly ONE 780x560 <canvas>, counted as one DOM node', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);

  const canvases = [];
  (function walk(node) {
    if (node.tagName === 'CANVAS' && node.className === 'cl2-tree-canvas') canvases.push(node);
    for (const c of node.children || []) walk(c);
  })(ui._tree.__nodeCountRoot());
  assert.equal(canvases.length, 1, 'exactly one connector canvas');
  assert.equal(canvases[0].width, 780);
  assert.equal(canvases[0].height, 560);
  ui.dispose();
});

test('Tree: the connector canvas redraws only when dirty — 0 redraws across N idle frames after the first', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx); // the "panel open" dirty trigger — the one allowed redraw

  const afterOpen = ui._tree.__redrawCount();
  assert.ok(afterOpen >= 1, 'opening the panel must redraw at least once');

  for (let i = 0; i < 30; i++) ui._tree.update(1 / 60, ctx);
  assert.equal(ui._tree.__redrawCount(), afterOpen, '30 idle frames with no interaction must add zero redraws');

  // Hover change is one of the four documented dirty triggers (09 §8.2).
  ui._tree.__hoverNode('cleaving_strike');
  ui._tree.update(1 / 60, ctx);
  assert.equal(ui._tree.__redrawCount(), afterOpen + 1, 'a hover change must trigger exactly one redraw');

  for (let i = 0; i < 10; i++) ui._tree.update(1 / 60, ctx);
  assert.equal(ui._tree.__redrawCount(), afterOpen + 1, 'still-hovering, no further change, adds zero redraws');

  ui.dispose();
});

// ---------------------------------------------------------------------------
// Detail card — describe() at N and N+1
// ---------------------------------------------------------------------------

test('Tree: the detail card shows describe() at level N (effective) and N+1 for the selected skill', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  const skills = ctx.get('skills');
  levelUpTo30(ctx, player);
  ui.openSkillTree();

  // Unallocated: N = 0. `tree.level` has no i18n entry yet (O-70 gap — see
  // tree.js's file header) so the header text is `t()`'s own
  // `[missing]tree.level` fallback, which drops the substituted `n` — the
  // level values are asserted directly against `skills.effectiveLevel`
  // below instead of parsed out of that fallback string.
  ui._tree.__select('whirlwind');
  ui._tree.update(1 / 60, ctx);
  assert.equal(ui._tree._dNameEl.textContent, 'WHIRLWIND');
  assert.equal(skills.effectiveLevel(player.actor, 'whirlwind'), 0);
  assert.notEqual(ui._tree._rows[0].cur.textContent, '', 'the LEVEL header must be populated even at N=0');

  // Allocate 4 for real, re-select — N should now read 4 via describe()'s
  // own N/N+1 pair, matching the wireframe's own worked example (09 §3.3's
  // ASCII art, "Lvl 4 -> 5").
  skills.allocate(player.actor, 'whirlwind');
  skills.allocate(player.actor, 'whirlwind');
  skills.allocate(player.actor, 'whirlwind');
  skills.allocate(player.actor, 'whirlwind');
  ui._tree.__select('cleaving_strike'); // force a change so the next select re-syncs
  ui._tree.__select('whirlwind');
  ui._tree.update(1 / 60, ctx);

  const N = skills.effectiveLevel(player.actor, 'whirlwind');
  assert.equal(N, 4);
  assert.equal(ui._tree._descOut.lineCount > 0, true, 'describe() at N must have produced at least one line');
  assert.equal(ui._tree._descOutNext.lineCount, ui._tree._descOut.lineCount, 'describe() at N and N+1 must produce the same line SHAPE (only values differ)');
  // The weaponDamage% line (whirlwind's own last line) must genuinely move
  // between N and N+1 — proves the second `describe()` call used `N+1`,
  // not a repeat of `N`.
  const lastIdx = ui._tree._descOut.lineCount - 1;
  assert.notEqual(ui._tree._descOut.lines[lastIdx].value, ui._tree._descOutNext.lines[lastIdx].value);

  // At least one stat row is populated (radius/cost/weaponDamage%).
  const populated = ui._tree._rows.slice(1).some((r) => r.label.textContent !== '');
  assert.ok(populated, 'at least one describe() line must be shown');

  ui.dispose();
});

test('Tree: at maxLevel the next column reads the MAXIMUM key, not a level-21 number', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  const skills = ctx.get('skills');
  levelUpTo30(ctx, player);
  for (let i = 0; i < 20; i++) skills.allocate(player.actor, 'cleaving_strike');
  assert.equal(skills.effectiveLevel(player.actor, 'cleaving_strike'), 20);

  ui.openSkillTree();
  ui._tree.__select('cleaving_strike');
  ui._tree.update(1 / 60, ctx);
  assert.equal(skills.effectiveLevel(player.actor, 'cleaving_strike'), 20);
  assert.match(ui._tree._rows[0].next.textContent, /tree\.maximum|MAXIMUM/i);
  ui.dispose();
});

// ---------------------------------------------------------------------------
// Provisional allocation, CONFIRM/REVERT, close-with-pending
// ---------------------------------------------------------------------------

test('Tree: LMB allocates a pending point when legal, RMB removes it, budget is respected', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player); // 29 points
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);

  ui._tree.__clickNode('cleaving_strike');
  assert.equal(ui._tree.__pendingOf('cleaving_strike'), 1);
  ui._tree.__clickNode('cleaving_strike');
  assert.equal(ui._tree.__pendingOf('cleaving_strike'), 2);
  ui._tree.__rightClickNode('cleaving_strike');
  assert.equal(ui._tree.__pendingOf('cleaving_strike'), 1);

  // Sunder (tier 18) is locked until bloodletting reaches 3 — pending
  // points on bloodletting must unlock it provisionally (09 §8.4: "a
  // prerequisite satisfied by a pending point immediately unlocks its
  // child").
  ui._tree.__clickNode('sunder');
  assert.equal(ui._tree.__pendingOf('sunder'), 0, 'sunder must stay locked before bloodletting reaches 3');
  ui._tree.__clickNode('bloodletting');
  ui._tree.__clickNode('bloodletting');
  ui._tree.__clickNode('bloodletting');
  assert.equal(ui._tree.__pendingOf('bloodletting'), 3);
  ui._tree.__clickNode('sunder');
  assert.equal(ui._tree.__pendingOf('sunder'), 1, 'sunder unlocks once bloodletting has 3 PENDING points');

  // Budget: drain the rest across two skills (one skill alone caps at its
  // own maxLevel, 20), then one more click must be refused.
  const before = ui._tree._remainingBudget();
  const firstBatch = Math.min(before, 20);
  for (let i = 0; i < firstBatch; i++) ui._tree.__clickNode('ram_charge');
  const secondBatch = before - firstBatch;
  for (let i = 0; i < secondBatch; i++) ui._tree.__clickNode('shield_stance');
  assert.equal(ui._tree._remainingBudget(), 0);
  const pendingBefore = ui._tree.__pendingOf('shield_stance');
  ui._tree.__clickNode('shield_stance');
  assert.equal(ui._tree.__pendingOf('shield_stance'), pendingBefore, 'a click past budget must not add a pending point');

  ui.dispose();
});

test('Tree: REVERT clears all pending without touching real allocation', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  const skills = ctx.get('skills');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);

  ui._tree.__clickNode('cleaving_strike');
  ui._tree.__clickNode('ram_charge');
  assert.ok(ui._tree.__pendingOf('cleaving_strike') > 0);
  ui._tree.__revert();
  assert.equal(ui._tree.__pendingOf('cleaving_strike'), 0);
  assert.equal(ui._tree.__pendingOf('ram_charge'), 0);
  assert.equal(skills.instanceOf(player.actor, 'cleaving_strike').allocated, 0, 'REVERT must never touch real allocation');
  ui.dispose();
});

test('Tree: closing with pending points shows the confirm dialog; Cancel keeps the panel open with pending intact; Discard clears and closes', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);

  ui._tree.__clickNode('cleaving_strike');
  ui._tree.close();
  assert.equal(ui._tree.isOpen(), true, 'close() with pending must not actually close yet');
  assert.equal(ui._tree.__dialogVisible(), true);

  ui._tree._onDialogCancel();
  assert.equal(ui._tree.__dialogVisible(), false);
  assert.equal(ui._tree.isOpen(), true);
  assert.equal(ui._tree.__pendingOf('cleaving_strike'), 1, 'Cancel must not discard pending points');

  ui._tree.close();
  assert.equal(ui._tree.__dialogVisible(), true);
  ui._tree._onDialogDiscard();
  assert.equal(ui._tree.isOpen(), false);
  assert.equal(ui._tree.__pendingOf('cleaving_strike'), 0, 'Discard must clear pending');
  ui.dispose();
});

test('Tree: closing with zero pending points closes immediately, no dialog', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);
  ui._tree.close();
  assert.equal(ui._tree.isOpen(), false);
  assert.equal(ui._tree.__dialogVisible(), false);
  ui.dispose();
});

// ---------------------------------------------------------------------------
// A full 29-point allocation, confirmed in one pass — save invariant 4
// ---------------------------------------------------------------------------

test('Tree: a full 29-point allocation across both trees confirms in one pass and matches save invariant 4', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  const skills = ctx.get('skills');
  ui.setScreen('game');

  levelUpTo30(ctx, player); // level 30 => level-1 = 29 skill points, via the real XP path (PLYR-4)
  assert.equal(player.hudState().level, 30);
  assert.equal(player.hudState().skillPoints, 29);

  installSpendSkillPoint(player, skills); // see file header — the missing contracted method, modelled for this test only

  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);

  let plannedTotal = 0;
  for (const id of RAVAGER_IDS) {
    plannedTotal += RAVAGER_29[id];
    for (let i = 0; i < RAVAGER_29[id]; i++) ui._tree.__clickNode(id);
  }
  assert.equal(plannedTotal, 29);
  ui._tree.update(1 / 60, ctx);

  const totalPendingBefore = RAVAGER_IDS.reduce((a, id) => a + ui._tree.__pendingOf(id), 0);
  assert.equal(totalPendingBefore, 29, 'every planned point must have landed as pending (all legal, budget covers it)');
  assert.equal(ui._tree._remainingBudget(), 0);

  ui._tree.__confirm(); // "in one pass" — a single CONFIRM click
  ui._tree.update(1 / 60, ctx);

  for (const id of RAVAGER_IDS) assert.equal(ui._tree.__pendingOf(id), 0, 'CONFIRM must clear every pending count');

  let sumSkillsValues = 0;
  for (const id of RAVAGER_IDS) sumSkillsValues += skills.instanceOf(player.actor, id).allocated;
  assert.equal(sumSkillsValues, 29, 'all 29 pending points must have landed as REAL allocated points in one CONFIRM pass');

  const unspentSkillPoints = player.hudState().skillPoints;
  assert.equal(unspentSkillPoints, 0);

  // 01-data-model.md §10.3 invariant 4: Σskills.values − ΣclassStartSkills +
  // unspentSkillPoints === level − 1. classStartSkills is 0 today —
  // CLASS_START_KIT (PLYR-6, M6) is not implemented, so no class pre-spends
  // a point yet (see tree.js's file header / this ticket's report).
  const classStartSkills = 0;
  const level = player.hudState().level;
  assert.equal(sumSkillsValues - classStartSkills + unspentSkillPoints, level - 1);

  // sunder's prerequisite really landed too (bloodletting confirmed before
  // sunder — ascending tier order).
  assert.equal(skills.instanceOf(player.actor, 'sunder').allocated, 3);
  assert.equal(skills.instanceOf(player.actor, 'bloodletting').allocated, 3);

  ui.dispose();
});

// ---------------------------------------------------------------------------
// Hover focus — hovering cleaving_strike highlights exactly its synergy
// edge to whirlwind
// ---------------------------------------------------------------------------

test('Tree: hovering cleaving_strike highlights exactly its synergy edge to whirlwind', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);

  ui._tree.__hoverNode('cleaving_strike');
  ui._tree.update(1 / 60, ctx);

  const focused = ui._tree.__focusedEdges();
  // eslint-disable-next-line no-console
  console.log('[tree.test] edges lit while hovering cleaving_strike:', focused);
  assert.equal(focused.length, 1, 'exactly one edge must be lit');
  assert.equal(focused[0].kind, 'synergy');
  assert.equal(focused[0].from, 'cleaving_strike');
  assert.equal(focused[0].to, 'whirlwind');

  ui._tree.__unhoverAll();
  ui._tree.update(1 / 60, ctx);
  assert.equal(ui._tree.__focusedEdges().length, 0);

  ui.dispose();
});

test('Tree: hovering sunder highlights both its prerequisite AND synergy edge from bloodletting', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.openSkillTree();
  ui._tree.update(1 / 60, ctx);

  ui._tree.__hoverNode('sunder');
  ui._tree.update(1 / 60, ctx);
  const focused = ui._tree.__focusedEdges();
  assert.equal(focused.length, 2);
  const kinds = focused.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['prereq', 'synergy']);
  for (const e of focused) { assert.equal(e.from, 'bloodletting'); assert.equal(e.to, 'sunder'); }
  ui.dispose();
});

// ---------------------------------------------------------------------------
// Screens / toggling
// ---------------------------------------------------------------------------

test('Tree: toggleSkillTree opens and closes; setScreen off "game" force-closes without the dialog', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.setScreen('game');

  ui.toggleSkillTree();
  assert.equal(ui._tree.isOpen(), true);
  ui._tree.update(1 / 60, ctx);
  ui._tree.__clickNode('cleaving_strike'); // leave a pending point behind

  ui.setScreen('main_menu'); // must force-close, bypassing the dialog
  assert.equal(ui._tree.isOpen(), false);
  assert.equal(ui._tree.__dialogVisible(), false);

  ui.setScreen('game');
  ui.toggleSkillTree();
  assert.equal(ui._tree.isOpen(), true);
  ui.dispose();
});

test('Tree: debugState("tree") opens the panel', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const player = ctx.get('player');
  levelUpTo30(ctx, player);
  ui.setScreen('game');
  ui.debugState('tree');
  assert.equal(ui._tree.isOpen(), true);
  ui.dispose();
});
