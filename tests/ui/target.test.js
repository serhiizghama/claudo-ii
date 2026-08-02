// tests/ui/target.test.js
//
// UI-8 acceptance tests for src/ui/target.js (the `Target` module) and the
// lines it adds to src/ui/index.js (`UiSystem#lateUpdate`/`#setTargetBar`/
// `#debugState`/`#setScreen`/`#dispose` delegation). `node:test` +
// `node:assert/strict` only (12-testing.md P6).
//
// Scope: this file owns `09-ui.md` §15's U4 acceptance row — all four rank
// layouts staged and rendered (D-41: hand-built records, never
// `ai.debugStage`), a boss crossing 60% flashing its phase tick, the
// 24-entry buff strip reading `skills.buffList` and depleting radially, and
// the two DOM node ceilings (16 / 72, `09 §13.1`). Most of these need a real
// `combat`/`skills`/`player`/`actors` to be honest (immunity, buffList,
// STATUS_ORDER debuffs) — built against a REAL `boot()`, one instance for
// the whole file, the same "ONE boot() per file" precedent
// `tests/skills/buff.test.js`'s own header establishes.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Target } from '../../src/ui/target.js';
import { UiSystem } from '../../src/ui/index.js';
import { el, countNodes } from '../../src/ui/util.js';
import { boot } from '../../src/main.js';
import { Rng } from '../../src/core/rng.js';

function makeCanvas(width = 1280, height = 720) {
  return {
    width, height, clientWidth: width, clientHeight: height,
    addEventListener() {}, removeEventListener() {},
  };
}

function makeBareCtx(overrides = {}) {
  return {
    canvas: makeCanvas(),
    rng: new Rng(12345),
    get() { return null; },
    has() { return false; },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Construction — Node-safe, allocates its DOM tree exactly once.
// ---------------------------------------------------------------------------

test('Target: constructs without throwing under a bare ctx ({}) and a Node-shim layer', () => {
  const layer = el('div');
  assert.doesNotThrow(() => new Target({}, layer, (k) => k, null));
});

test('Target: attaches every node it builds into the given layer, nothing left outside it', () => {
  const layer = el('div');
  const target = new Target(makeBareCtx(), layer, (k) => k, null);
  void target;
  assert.equal(countNodes(layer) - 1, 15 + 24 * 3, 'target bar (15) + buff strip (24x3=72) = 87 nodes attached');
});

test('Target: dispose() removes every node it created from the layer', () => {
  const layer = el('div');
  const target = new Target(makeBareCtx(), layer, (k) => k, null);
  const before = countNodes(layer);
  assert.ok(before > 1);
  target.dispose();
  assert.equal(countNodes(layer), 1, 'only the layer itself remains once disposed');
});

test('Target: update()/setTargetBar() never throw under a bare ctx (no player/skills/combat present)', () => {
  const layer = el('div');
  const target = new Target(makeBareCtx(), layer, (k) => k, null);
  target.setVisible(true);
  assert.doesNotThrow(() => target.setTargetBar({ id: 1, rank: 'normal', name: 'x', level: 1, life: 10, stats: { maxLife: 10 }, statuses: [], affixes: [] }));
  assert.doesNotThrow(() => target.update(1 / 60, makeBareCtx()));
  assert.doesNotThrow(() => target.setTargetBar(null));
});

// ---------------------------------------------------------------------------
// §13.1 DOM node budget — ceilings, never "nothing else exists" (O-27).
// ---------------------------------------------------------------------------

test('Target#__targetBarNodeCount() stays <= 16 (09 §13.1)', () => {
  const layer = el('div');
  const target = new Target(makeBareCtx(), layer, (k) => k, null);
  const n = target.__targetBarNodeCount();
  assert.ok(n > 0, 'the target bar must draw something');
  assert.ok(n <= 16, `target bar node count ${n} exceeds the 16-node ceiling`);
});

test('Target#__buffStripNodeCount() stays <= 72 (09 §13.1)', () => {
  const layer = el('div');
  const target = new Target(makeBareCtx(), layer, (k) => k, null);
  const n = target.__buffStripNodeCount();
  assert.ok(n > 0, 'the buff strip must draw something');
  assert.ok(n <= 72, `buff strip node count ${n} exceeds the 72-node ceiling`);
});

test('full boot(): ui.__nodeCount() stays well under the 700-node cap with the target bar + buff strip attached', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  const count = ui.__nodeCount();
  assert.ok(count < 700, `09 §13.1 hard cap; got ${count}`);
  ui.dispose();
});

// ---------------------------------------------------------------------------
// D-41 — all four rank layouts, staged from hand-built records, never
// `ai.debugStage` (unimplemented, src/ai/index.js:16) and never guarded
// with `typeof ai.debugStage === 'function'` (the forbidden O-27/O-39 shape).
// ---------------------------------------------------------------------------

test('D-41: Target#__debugStageRank stages all four rank layouts (+minion) without touching ai.debugStage', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  ui.setScreen('game');
  // Sanity for D-41: `ai` is not even registered in this boot() (main.js
  // has no `registry.add(AiSystem)` line today) — this test's own staging
  // path (`__debugStageRank`) must not depend on it existing at all.
  assert.equal(ctx.has('ai'), false, 'sanity: ai is not registered in this boot — D-41 staging must not depend on it');

  const target = ui._target;

  // normal / minion — 280x8, level prefix, no chips, no percentage.
  for (const rank of ['normal', 'minion']) {
    ui.debugState('target_' + rank);
    ui.lateUpdate(1 / 60, ctx);
    assert.equal(target._name.style.display, 'block', `${rank}: name must render`);
    assert.ok(target._name.textContent.indexOf('14') >= 0, `${rank}: level prefix must be present in "${target._name.textContent}"`);
    assert.equal(target._percentage.style.display, 'none', `${rank}: no percentage`);
    assert.equal(target._chips.filter((c) => c.style.display === 'block').length, 0, `${rank}: no affix chips`);
  }

  // champion — 360x12, --property seam, affix chips.
  ui.debugState('target_champion');
  ui.lateUpdate(1 / 60, ctx);
  assert.equal(target._track.style.width, '360px', 'champion: 360px bar width');
  assert.equal(target._track.style.height, '12px', 'champion: 12px bar height');
  assert.ok(target._chips.some((c) => c.style.display === 'block'), 'champion: at least one affix chip shown');
  assert.equal(target._track.style.borderBottom, '2px solid var(--property)', 'champion: --property seam');

  // unique — 420x14, unique-gold seam, affix chips, 3 rank pips (folded
  // into the ticks node's background — see target.js's own header).
  ui.debugState('target_unique');
  ui.lateUpdate(1 / 60, ctx);
  assert.equal(target._track.style.width, '420px', 'unique: 420px bar width');
  assert.equal(target._track.style.height, '14px', 'unique: 14px bar height');
  assert.ok(target._chips.some((c) => c.style.display === 'block'), 'unique: at least one affix chip shown');
  assert.equal(target._track.style.borderBottom, '2px solid var(--rarity-unique)', 'unique: unique-gold seam');
  assert.ok(target._ticks.style.background.indexOf('radial-gradient') >= 0, 'unique: rank pips are a radial-gradient layer on the ticks node, no extra DOM');

  // boss — 720x20, e1 plate 800x78, phase ticks, percentage.
  ui.debugState('target_boss');
  ui.lateUpdate(1 / 60, ctx);
  assert.equal(target._track.style.width, '720px', 'boss: 720px bar width');
  assert.equal(target._track.style.height, '20px', 'boss: 20px bar height');
  assert.equal(target._plate.style.display, 'block', 'boss: the e1 plate is shown');
  assert.equal(target._plate.style.width, '800px', 'boss: 800px plate width');
  assert.equal(target._plate.style.height, '78px', 'boss: 78px plate height');
  assert.equal(target._percentage.style.display, 'block', 'boss: the percentage readout is shown');
  assert.ok(/^\d+ %$/.test(target._percentage.textContent), `boss: percentage text should read "NN %", got "${target._percentage.textContent}"`);

  ui.dispose();
});

test('D-41: setTargetBar(null) hides the target bar entirely', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  ui.setScreen('game');
  ui.debugState('target_boss');
  ui.lateUpdate(1 / 60, ctx);
  assert.equal(ui._target._track.style.display, 'block');
  ui.setTargetBar(null);
  assert.equal(ui._target._track.style.display, 'none');
  assert.equal(ui._target._plate.style.display, 'none');
  ui.dispose();
});

// ---------------------------------------------------------------------------
// Boss phase tick — crossing 60% flashes it (the acceptance text's own
// wording), integrated from dt every frame, never a CSS transition.
// ---------------------------------------------------------------------------

test('a boss crossing 60% flashes its phase tick (--ink-1), and it decays back to --ember, integrated from dt', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  ui.setScreen('game');
  ui.debugState('target_boss');
  const target = ui._target;
  const boss = target._targetActor;
  boss.stats.maxLife = 1000;
  boss.life = 700; // 70%, above the 60% threshold

  for (let i = 0; i < 5; i++) ui.lateUpdate(1 / 60, ctx);
  assert.ok(target._ticks.style.background.indexOf('var(--ink-1)') === -1, 'above 60%: the tick must not be flashing yet');
  assert.ok(target._ticks.style.background.indexOf('var(--ember)') >= 0, 'above 60%: the tick is the idle --ember colour');

  boss.life = 550; // drop to 55%, crossing 60% downward this frame
  ui.lateUpdate(1 / 60, ctx);
  assert.ok(target._ticks.style.background.indexOf('var(--ink-1)') >= 0, 'crossing 60% downward must flash the tick --ink-1 this frame');

  // No CSS transition anywhere — the trap this ticket's brief names by
  // number. The flash must decay by explicit per-frame dt integration.
  assert.equal(target._ticks.style.transition, undefined, 'no CSS transition property must ever be set on the ticks node');
  for (let i = 0; i < 40; i++) ui.lateUpdate(1 / 60, ctx); // > PHASE_FLASH_S (0.5s) of frames
  assert.ok(target._ticks.style.background.indexOf('var(--ink-1)') === -1, 'the flash must have decayed back to --ember after PHASE_FLASH_S has elapsed, integrated frame by frame');

  ui.dispose();
});

// ---------------------------------------------------------------------------
// The 24-entry buff strip reads skills.buffList and depletes radially,
// integrated from dt (never a CSS transition).
// ---------------------------------------------------------------------------

test('the buff strip reads skills.buffList for the PLAYER actor and shows a live buff', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  const skills = ctx.get('skills');
  const player = ctx.get('player');
  ui.setScreen('game');
  const target = ui._target;

  ctx.time.step = 1000;
  skills.applyBuff(player.actor, 'war_cry', 10, 12.0);
  ui.lateUpdate(1 / 60, ctx);

  const shown = target._buffPlates.filter((p) => p.style.display === 'block').length;
  assert.equal(shown, 1, 'exactly one buff icon must be showing after war_cry is applied');
  assert.equal(target._buffPlates[0].style.borderBottomColor, 'var(--verdigris)', 'a buff carries the --verdigris bottom seam (09 §4.6)');
  assert.equal(target._buffPlates[0].getAttribute('data-ui-solid'), '', 'O-78: a solid HUD node must be marked so a click cannot leak through to world click-to-move');

  ui.dispose();
});

test('the radial depletion sweep advances every frame as skills.buffList\'s remaining decreases, integrated from dt — never a CSS transition', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  const skills = ctx.get('skills');
  const player = ctx.get('player');
  ui.setScreen('game');
  const target = ui._target;

  ctx.time.step = 2000;
  skills.applyBuff(player.actor, 'last_stand', 5, 8.0);

  ui.lateUpdate(1 / 60, ctx);
  assert.equal(target._buffPlates[0].style.transition, undefined, 'no CSS transition on the buff plate');

  const angles = [];
  for (let i = 0; i < 30; i++) {
    ctx.time.step += 6; // 0.1s per sample
    ui.lateUpdate(1 / 60, ctx);
    angles.push(target._buffSlotState[0].lastAngleQ);
  }
  let increased = false;
  for (let i = 1; i < angles.length; i++) {
    assert.ok(angles[i] >= angles[i - 1], `the sweep angle must be monotonically non-decreasing as remaining depletes; got ${angles.join(',')}`);
    if (angles[i] > angles[i - 1]) increased = true;
  }
  assert.ok(increased, 'the sweep angle must actually advance across frames, not sit frozen');

  ui.dispose();
});

test('debuffs are ordered before buffs (STATUS_ORDER), both merged into the same 24-slot strip', async () => {
  const { ctx } = await boot({ canvas: makeCanvas(), deterministic: true, global: {} });
  const ui = ctx.get('ui');
  const skills = ctx.get('skills');
  const player = ctx.get('player');
  ui.setScreen('game');
  const target = ui._target;
  const actor = player.actor;

  ctx.time.step = 3000;
  skills.applyBuff(actor, 'war_cry', 10, 12.0);
  actor.statuses.push({
    status: 'burning', sourceId: 1, sourceGen: 1, sourceSkill: 'x', element: 'fire',
    magnitude: 5, stacks: 1, appliedStep: ctx.time.step, expiresStep: ctx.time.step + 240,
    nextTickStep: 0, totalRemaining: 100, statMods: null, poolIndex: -1,
  });

  ui.lateUpdate(1 / 60, ctx);

  assert.equal(target._buffSlotState[0].lastKey, 'debuff:burning', 'slot 0 must be the debuff (STATUS_ORDER: burning first)');
  assert.equal(target._buffPlates[0].style.borderBottomColor, 'var(--danger)', 'a debuff carries the --danger bottom seam (09 §4.6)');
  assert.equal(target._buffSlotState[1].lastKey, 'buff:war_cry', 'slot 1 must be the buff, after the debuff');

  ui.dispose();
});

// ---------------------------------------------------------------------------
// UiSystem wiring — setVisible/setScreen gating, dispose.
// ---------------------------------------------------------------------------

test('UiSystem#setScreen gates the target bar + buff strip the same way it gates the plinth/hotbar', async () => {
  const sys = new UiSystem();
  await sys.init(makeBareCtx());
  sys.setScreen('game');
  assert.equal(sys._target._visible, true);
  sys.setScreen('main_menu');
  assert.equal(sys._target._visible, false);
  sys.dispose();
});

test('UiSystem#setTargetBar delegates to Target#setTargetBar', async () => {
  const sys = new UiSystem();
  await sys.init(makeBareCtx());
  sys.setScreen('game');
  assert.doesNotThrow(() => sys.setTargetBar({ id: 5, rank: 'normal', name: 'x', level: 1, life: 5, stats: { maxLife: 10 }, statuses: [], affixes: [] }));
  assert.equal(sys._target._targetActor.id, 5);
  sys.dispose();
});
