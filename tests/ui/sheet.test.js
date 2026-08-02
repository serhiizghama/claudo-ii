// tests/ui/sheet.test.js
//
// UI-10 acceptance tests for src/ui/sheet.js (the `Sheet` module, its two
// pure paperdoll-placement helpers `computePaperdollPlacement`/
// `projectedScreenBounds`) and the lines this ticket adds to
// src/ui/index.js (`_sheet`, `toggleCharacterSheet`, the `toggleInventory`
// pairing, `debugState('character')`, and O-78's `pointerOverUi`
// mechanism). `node:test` + `node:assert/strict` only (12-testing.md P6).
//
// Real subsystems throughout, `src/main.js#boot()`'s own precedent
// (tests/render/camera.test.js, tests/ui/inventory.test.js's "full boot()"
// case) — a canvas stub with no `getContext` takes the degraded no-GPU
// render path, but `ItemsSystem`/`ActorsSystem`/`PlayerSystem`/`UiSystem`
// all construct and init for real, so `actors.stats()`/`items.equip()`
// under test are the genuine production implementations, not stand-ins.
//
// This ticket's own acceptance clauses, and where each lives below:
//   1. Ten equipment slots, attribute block, derived stats, advanced page,
//      uiScene paperdoll viewport — "construction and DOM budget" section.
//   2. The paperdoll lands inside its computed rectangle at 720p/1080p/
//      1440p — "paperdoll placement" section (pure-math, no GPU needed).
//   3. Equip -> a derived number changes in the same frame `stats:dirty`
//      resolves — "equip changes derived stats" section.
//   4. `I` opens the sheet AND inventory as a pair; `C` opens the sheet
//      alone — "I/C pairing" section.
//   5. O-78's `ui` half of `pointerOverUi` — "pointerOverUi" section.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { boot } from '../../src/main.js';
import { countNodes } from '../../src/ui/util.js';
import {
  computePaperdollPlacement,
  projectedScreenBounds,
  buildPaperdollGroup,
} from '../../src/ui/sheet.js';
// PLYR-4 fix (the placeholder player actor now correctly spawns at level 1,
// src/player/index.js's own PLACEHOLDER_LEVEL — see that ticket's report):
// three fixtures below equip a `reqLevel: 4` base, which a level-1 actor
// legitimately cannot wear (src/items/equipment.js's `canEquip`, "correct
// behaviour"). `XP_TABLE` lets those fixtures raise the actor to level 4
// through the real path (`player.grantXp`) instead of writing `actor.level`
// directly.
import { XP_TABLE } from '../../src/player/data/progression.js';

function makeCanvas(width = 1280, height = 720) {
  return { width, height, addEventListener() {}, removeEventListener() {} };
}

async function bootAt(width, height) {
  return boot({ canvas: makeCanvas(width, height), width, height, deterministic: true, global: {} });
}

let _uid = 90000;
function makeItem(items, baseId, overrides = {}) {
  const base = items.base(baseId);
  const o = overrides;
  return {
    uid: _uid++,
    baseId,
    rarity: o.rarity || 'normal',
    ilvl: o.ilvl || (base ? base.reqLevel : 1),
    identified: true,
    quantity: 1,
    rolls: o.rolls || { defense: 0, superior: 0, damageMin: base && base.weapon ? base.weapon.minDamage : 0, damageMax: base && base.weapon ? base.weapon.maxDamage : 0 },
    affixes: o.affixes || [],
    uniqueId: null, uniqueValues: [], nameOverride: null,
    durability: base ? base.maxDurability : 1, maxDurability: base ? base.maxDurability : 1,
    sockets: [], socketCount: 0,
    grid: null, slot: null, ground: null,
  };
}

// ---------------------------------------------------------------------------
// Construction and DOM budget
// ---------------------------------------------------------------------------

test('Sheet: constructs under a real boot(), sheet root node count stays <= 104 (09 §13.1)', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  ui.setScreen('game');
  ui.toggleCharacterSheet();
  ui._sheet.update(1 / 60, ctx);

  const n = countNodes(ui._sheet.__nodeCountRoot());
  // eslint-disable-next-line no-console
  console.log(`[sheet.test] character sheet node count = ${n} (ceiling 104)`);
  assert.ok(n <= 104, `character sheet must stay <= 104 DOM nodes; got ${n}`);
  assert.ok(n > 20, 'sanity: the sheet is not suspiciously empty');

  assert.ok(ui.__nodeCount() <= 700, "09 §13.1's whole-tree 700-node cap must still hold");
  ui.dispose();
});

test('Sheet: ten equipment slots exist, one DOM node per slot marked with its own data-cl2-slot id', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  ui.setScreen('game');
  ui.toggleCharacterSheet();

  const ids = ui._sheet._slots.map((s) => s.def.id).sort();
  assert.deepEqual(ids, ['amulet', 'belt', 'chest', 'hands', 'head', 'legs', 'mainHand', 'offHand', 'ring1', 'ring2'].sort());
  for (const slot of ui._sheet._slots) {
    assert.equal(slot.wrapEl.getAttribute('data-cl2-slot'), slot.def.id);
  }
  ui.dispose();
});

test('Sheet: the panel root carries data-ui-solid (O-78\'s ui half)', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  ui.toggleCharacterSheet();
  assert.equal(ui._sheet.__nodeCountRoot().getAttribute('data-ui-solid'), '');
  ui.dispose();
});

test('Sheet: a pointerdown on the panel stops propagation', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  ui.toggleCharacterSheet();
  let stopped = false;
  const fakeTarget = { closest: () => null };
  ui._sheet._onPanelPointerDown({ type: 'pointerdown', target: fakeTarget, stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true);
  ui.dispose();
});

// ---------------------------------------------------------------------------
// Paperdoll placement — pure math, no GPU needed (Vector3#project works
// under plain Node — tests/render/camera.test.js's own precedent)
// ---------------------------------------------------------------------------

/** Mirrors src/main.js#buildUiCamera exactly (fov/near/far/position/lookAt)
 * — not imported (that function is module-private to main.js), matching
 * every other "transcribe, do not import the composition root" precedent
 * in this tree. */
function buildTestUiCamera(width, height) {
  const camera = new THREE.PerspectiveCamera(45, width / Math.max(height, 1), 0.1, 50);
  camera.position.set(0, 1, 3);
  camera.lookAt(0, 1, 0);
  return camera;
}

const RESOLUTIONS = [
  { name: '720p', w: 1280, h: 720 },
  { name: '1080p', w: 1920, h: 1080 },
  { name: '1440p', w: 2560, h: 1440 },
];

test('Sheet paperdoll: the target rectangle is the SAME absolute pixel rect at 720p, 1080p and 1440p (the panel is corner-anchored, never scaled)', async () => {
  const rects = [];
  for (const r of RESOLUTIONS) {
    const { ctx } = await bootAt(r.w, r.h);
    const ui = ctx.get('ui');
    ui.toggleCharacterSheet();
    ui._sheet.update(1 / 60, ctx);
    const rect = ui._sheet.__paperdollRect(ctx);
    rects.push({ res: r.name, ...rect });
    ui.dispose();
  }
  // eslint-disable-next-line no-console
  console.log('[sheet.test] paperdoll computed rectangle at each resolution:', JSON.stringify(rects));
  assert.deepEqual({ x: rects[0].x, y: rects[0].y, w: rects[0].w, h: rects[0].h }, { x: rects[1].x, y: rects[1].y, w: rects[1].w, h: rects[1].h });
  assert.deepEqual({ x: rects[1].x, y: rects[1].y, w: rects[1].w, h: rects[1].h }, { x: rects[2].x, y: rects[2].y, w: rects[2].w, h: rects[2].h });
  assert.equal(rects[0].x, 168);
  assert.equal(rects[0].y, 180);
  assert.equal(rects[0].w, 152);
  assert.equal(rects[0].h, 236);
});

test('Sheet paperdoll: computePaperdollPlacement + projectedScreenBounds land the mannequin INSIDE its computed rectangle at 720p, 1080p and 1440p', () => {
  const group = buildPaperdollGroup();
  const localBox = group.userData.__localBox;
  const rectAbs = { x: 168, y: 180, w: 152, h: 236 };
  const depth = 3;

  for (const r of RESOLUTIONS) {
    const camera = buildTestUiCamera(r.w, r.h);
    const placement = computePaperdollPlacement(camera, r.w, r.h, rectAbs, depth, localBox);
    const bounds = projectedScreenBounds(camera, r.w, r.h, placement.position, placement.scale, localBox);

    // eslint-disable-next-line no-console
    console.log(`[sheet.test] ${r.name} (${r.w}x${r.h}): computed rect = ${JSON.stringify(rectAbs)}, actual projected bounds = x[${bounds.x0.toFixed(2)}..${bounds.x1.toFixed(2)}] y[${bounds.y0.toFixed(2)}..${bounds.y1.toFixed(2)}]`);

    const EPS = 0.5; // sub-pixel slack for float rounding only
    assert.ok(bounds.x0 >= rectAbs.x - EPS, `${r.name}: left edge ${bounds.x0} must be inside the rect (>= ${rectAbs.x})`);
    assert.ok(bounds.x1 <= rectAbs.x + rectAbs.w + EPS, `${r.name}: right edge ${bounds.x1} must be inside the rect (<= ${rectAbs.x + rectAbs.w})`);
    assert.ok(bounds.y0 >= rectAbs.y - EPS, `${r.name}: top edge ${bounds.y0} must be inside the rect (>= ${rectAbs.y})`);
    assert.ok(bounds.y1 <= rectAbs.y + rectAbs.h + EPS, `${r.name}: bottom edge ${bounds.y1} must be inside the rect (<= ${rectAbs.y + rectAbs.h})`);

    // And it must not be a degenerate (zero-size) placement.
    assert.ok(bounds.x1 - bounds.x0 > 10, `${r.name}: projected width must be non-trivial; got ${bounds.x1 - bounds.x0}`);
    assert.ok(bounds.y1 - bounds.y0 > 10, `${r.name}: projected height must be non-trivial; got ${bounds.y1 - bounds.y0}`);
  }
});

test('Sheet paperdoll: the group is only visible in uiScene while the sheet is open, and hidden when closed', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  assert.equal(ui._sheet._paperdollGroup.visible, false);
  ui.toggleCharacterSheet();
  assert.equal(ui._sheet._paperdollGroup.visible, true);
  ui.toggleCharacterSheet();
  assert.equal(ui._sheet._paperdollGroup.visible, false);
  ui.dispose();
});

// ---------------------------------------------------------------------------
// Equip changes a derived number in the same frame stats:dirty resolves
// ---------------------------------------------------------------------------

test('Sheet: equipping armour changes Defence, read back the SAME frame stats:dirty resolves (actors.stats recomposes on read)', async () => {
  const { ctx, engine } = await bootAt(1280, 720);
  const items = ctx.get('items');
  const actors = ctx.get('actors');
  const player = ctx.get('player');
  const actor = player.actor;
  // armour_quilted_normal's reqLevel is 4 — the fixture actor legitimately
  // needs to be level 4 to wear it (equipment.js's canEquip is correct to
  // refuse it at level 1). Real path: grant exactly enough XP to reach
  // level 4, then let one fixed step process the level-up.
  player.grantXp(XP_TABLE[4], 0);
  engine.frame(1 / 60);
  const ui = ctx.get('ui');
  ui.setScreen('game');
  ui.toggleCharacterSheet();

  ui._sheet.update(1 / 60, ctx);
  const before = actors.stats(actor).defense;
  const beforeText = ui._sheet._derivedEls[2].el.textContent;

  // A real rolled defence value (armour_quilted_normal's own defMin..defMax
  // band, 04-items.md's roll rules) — the default `rolls.defense: 0` a bare
  // fixture would otherwise carry contributes nothing to the stat block.
  const chest = makeItem(items, 'armour_quilted_normal', { rolls: { defense: 20, superior: 0, damageMin: 0, damageMax: 0 } });
  const res = items.equip(actor, chest, 'chest');
  assert.equal(res.ok, true, `equip must succeed: ${res.reason}`);

  // Read within the SAME frame — no fixedUpdate/lateUpdate pump in between,
  // matching this ticket's own criterion wording.
  const after = actors.stats(actor).defense;
  assert.ok(after > before, `defense must increase after equipping armour; before=${before} after=${after}`);

  ui._sheet.update(1 / 60, ctx); // the sheet's own next draw, still the same tick in this test
  const afterText = ui._sheet._derivedEls[2].el.textContent;
  assert.notEqual(afterText, beforeText, 'the sheet\'s displayed Defence text must have changed');
  assert.equal(afterText, String(Math.round(after)));

  // eslint-disable-next-line no-console
  console.log(`[sheet.test] Defence before=${before} ("${beforeText}") after=${after} ("${afterText}")`);

  ui.dispose();
});

test('Sheet: clicking a filled slot with nothing on the cursor unequips to the inventory', async () => {
  const { ctx, engine } = await bootAt(1280, 720);
  const items = ctx.get('items');
  const player = ctx.get('player');
  const actor = player.actor;
  // ring_iron's reqLevel is 4 — same real-path level-up as the Defence test
  // above.
  player.grantXp(XP_TABLE[4], 0);
  engine.frame(1 / 60);
  const ui = ctx.get('ui');
  ui.toggleCharacterSheet();

  const ring = makeItem(items, 'ring_iron', {});
  assert.equal(items.equip(actor, ring, 'ring1').ok, true);
  assert.equal(items.equipped(actor, 'ring1'), ring);

  ui._sheet._attemptSlotInteraction('ring1');
  assert.equal(items.equipped(actor, 'ring1'), null);
  assert.equal(ring.grid && ring.grid.container, 'inventory');
  ui.dispose();
});

test('Sheet: clicking an empty slot with a legal item on the cursor equips it', async () => {
  const { ctx, engine } = await bootAt(1280, 720);
  const items = ctx.get('items');
  const player = ctx.get('player');
  const actor = player.actor;
  // ring_iron's reqLevel is 4 — same real-path level-up as the two tests
  // above.
  player.grantXp(XP_TABLE[4], 0);
  engine.frame(1 / 60);
  const ui = ctx.get('ui');
  ui.toggleCharacterSheet();

  const ring = makeItem(items, 'ring_iron', {});
  assert.ok(items.takeToCursor(ring));
  assert.equal(items.cursorItem, ring);

  ui._sheet._attemptSlotInteraction('ring2');
  assert.equal(items.equipped(actor, 'ring2'), ring);
  assert.equal(items.cursorItem, null);
  ui.dispose();
});

// ---------------------------------------------------------------------------
// I opens sheet + inventory as a pair; C opens the sheet alone
// ---------------------------------------------------------------------------

test('UiSystem: toggleInventory() opens/closes the character sheet as a pair (09 §11.2 "I")', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  ui.setScreen('game');

  assert.equal(ui._inventory.isOpen(), false);
  assert.equal(ui._sheet.isOpen(), false);

  ui.toggleInventory();
  assert.equal(ui._inventory.isOpen(), true, 'I opens the inventory');
  assert.equal(ui._sheet.isOpen(), true, 'I opens the character sheet alongside it');

  ui.toggleInventory();
  assert.equal(ui._inventory.isOpen(), false, 'I again closes the inventory');
  assert.equal(ui._sheet.isOpen(), false, 'I again closes the character sheet too');

  ui.dispose();
});

test('UiSystem: toggleCharacterSheet() opens/closes the sheet ALONE (09 §11.2 "C") — never touches the inventory', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  ui.setScreen('game');

  ui.toggleCharacterSheet();
  assert.equal(ui._sheet.isOpen(), true, 'C opens the sheet');
  assert.equal(ui._inventory.isOpen(), false, 'C must not open the inventory');

  ui.toggleCharacterSheet();
  assert.equal(ui._sheet.isOpen(), false);
  assert.equal(ui._inventory.isOpen(), false);

  ui.dispose();
});

test('UiSystem: I then C then I — the pair re-syncs correctly (C detaches the sheet, a later I re-attaches it)', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  ui.setScreen('game');

  ui.toggleInventory(); // both open
  ui.toggleCharacterSheet(); // sheet closes alone
  assert.equal(ui._inventory.isOpen(), true);
  assert.equal(ui._sheet.isOpen(), false);

  ui.toggleInventory(); // I: inventory closes, sheet re-synced to closed (already closed)
  assert.equal(ui._inventory.isOpen(), false);
  assert.equal(ui._sheet.isOpen(), false);

  ui.toggleInventory(); // I again: both open together, from scratch
  assert.equal(ui._inventory.isOpen(), true);
  assert.equal(ui._sheet.isOpen(), true);

  ui.dispose();
});

test('UiSystem: debugState(\'character\') opens the sheet, without touching debugState(\'combat\')/(\'inventory\')\'s own branches', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  ui.setScreen('game');
  ui.debugState('character');
  assert.equal(ui._sheet.isOpen(), true);
  ui.dispose();
});

// ---------------------------------------------------------------------------
// O-78 — the ui half of pointerOverUi
// ---------------------------------------------------------------------------

test('UiSystem.pointerOverUi: false by default, true while a solid pointerdown/pointermove hit-tests inside #ui', async () => {
  const { ctx } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  assert.equal(ui.pointerOverUi, false);

  // A synthetic root/target pair, standing in for the real DOM's
  // `Node#contains`/`Element#closest` — the Node shim (`./util.js`)
  // implements neither, so this exercises the real `_onGuardPointerEvent`
  // algorithm end to end with the minimum DOM surface it actually needs.
  const solidTarget = { closest: (sel) => (sel === '[data-ui-solid]' ? solidTarget : null) };
  const savedRoot = ui._root;
  ui._root = { contains: () => true };

  ui.__simulatePointerGuardEvent('pointermove', solidTarget);
  assert.equal(ui.pointerOverUi, true, 'a solid hit-test makes pointerOverUi true live');

  const outsideTarget = { closest: () => null };
  ui.__simulatePointerGuardEvent('pointermove', outsideTarget);
  assert.equal(ui.pointerOverUi, false, 'moving off every solid node drops it back to false');

  ui._root = savedRoot;
  ui.dispose();
});

test('UiSystem.pointerOverUi: the close-click guard holds true for 2 extra frames after a solid pointerdown (09 §11.4 point 4)', async () => {
  const { ctx, engine } = await bootAt(1280, 720);
  const ui = ctx.get('ui');
  const solidTarget = { closest: (sel) => (sel === '[data-ui-solid]' ? solidTarget : null) };
  const savedRoot = ui._root;
  ui._root = { contains: () => true };

  ui.__simulatePointerGuardEvent('pointerdown', solidTarget);
  assert.equal(ui.pointerOverUi, true);

  // Simulate the panel having closed: the NEXT hit-test lands nowhere solid
  // (same shape as `09`'s own example — the panel that was just dismissed
  // no longer exists to hit-test against).
  const outsideTarget = { closest: () => null };
  ui.__simulatePointerGuardEvent('pointermove', outsideTarget);
  // The live hit-test alone would now read false, but the swallow window
  // (armed for `render.frameIndex + 2` by the pointerdown above) must
  // still hold.
  assert.equal(ui._pointerOverUiLive, false, 'sanity: the live hit-test really did go false');
  assert.equal(ui.pointerOverUi, true, 'the guard must still read true — the close-click hold');

  // Advance two real engine frames — `render.frameIndex` (what the guard
  // actually compares against, since a real `render` subsystem is present
  // via `boot()`) only advances through a real `engine.frame()` call, the
  // same lockstep pump `src/dev/shots.js#pumpShot` uses.
  engine.frame(1 / 60);
  engine.frame(1 / 60);
  assert.equal(ui.pointerOverUi, false, 'after 2 frames the guard must have expired');

  ui._root = savedRoot;
  ui.dispose();
});
