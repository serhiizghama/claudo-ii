// tests/core/input.test.js
//
// CORE-7 acceptance tests for src/core/input.js. `node:test` +
// `node:assert/strict` only — no framework (12-testing.md P6), no DOM: DOM
// events are fed either straight into the internal receivers (`_onKeyDown`
// etc. — the "internal receiver" option the CORE-7 brief allows) or through
// a minimal `addEventListener`/`removeEventListener` stand-in for `attach()`.
// Plain Node has no `window` global, which is itself part of what these
// tests lean on: `Input` must construct (and, per the brief, `attach()` to a
// stub target) without one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Input } from '../../src/core/input.js';

/** A minimal `EventTarget`-shaped stub so `attach()`/`detach()` can be
 * exercised without a real DOM. Records listeners per event type and lets
 * the test dispatch a plain object straight to them. */
function makeFakeTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      const set = listeners.get(type);
      if (set) set.delete(fn);
    },
    _dispatch(type, event) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of set) fn(event);
    },
    _listenerCount(type) {
      const set = listeners.get(type);
      return set ? set.size : 0;
    },
  };
}

test('module imports in Node and constructs without attach() — no window/document touched', () => {
  assert.equal(typeof Input, 'function');
  const input = new Input();
  assert.deepEqual(input.pointer, { x: 0, y: 0 });
  assert.equal(input.wheelDeltaY, 0);
  // Nothing pressed yet, for a code that was never seen and one that was
  // pre-registered — neither path throws or needs a prior beginFrame().
  assert.equal(input.keyHeld('KeyW'), false);
  assert.equal(input.keyHeld('KeyZ'), false);
  assert.equal(input.buttonHeld(0), false);
});

test('a raw edge is invisible until beginFrame() latches it, then pressed/held both read true', () => {
  const input = new Input();
  input._onKeyDown({ code: 'KeyW', repeat: false });

  // Landed between frames (per 11-flows.md §3.1) — not latched yet.
  assert.equal(input.keyHeld('KeyW'), false);
  assert.equal(input.keyPressed('KeyW'), false);

  input.beginFrame();
  assert.equal(input.keyHeld('KeyW'), true);
  assert.equal(input.keyPressed('KeyW'), true);
  assert.equal(input.keyReleased('KeyW'), false);
});

test('endFrame() clears "pressed this frame" but leaves "held" alone; a later idle beginFrame() keeps it held', () => {
  const input = new Input();
  input._onKeyDown({ code: 'KeyW', repeat: false });
  input.beginFrame();
  assert.equal(input.keyPressed('KeyW'), true);

  input.endFrame();
  assert.equal(input.keyHeld('KeyW'), true, 'endFrame must not clear held');
  assert.equal(input.keyPressed('KeyW'), false, 'endFrame must clear the one-shot pressed edge');

  // A second frame with no new DOM events: still held, still not "pressed".
  input.beginFrame();
  assert.equal(input.keyHeld('KeyW'), true);
  assert.equal(input.keyPressed('KeyW'), false);
  input.endFrame();
});

test('OS auto-repeat keydown is not a new press edge', () => {
  const input = new Input();
  input._onKeyDown({ code: 'KeyW', repeat: false });
  input.beginFrame();
  input.endFrame();

  input._onKeyDown({ code: 'KeyW', repeat: true }); // held down, browser re-firing
  input.beginFrame();
  assert.equal(input.keyHeld('KeyW'), true);
  assert.equal(input.keyPressed('KeyW'), false, 'a repeat must not read as a fresh press');
});

test('release lands next beginFrame(): held goes false, released goes true, then clears on endFrame()', () => {
  const input = new Input();
  input._onKeyDown({ code: 'KeyS', repeat: false });
  input.beginFrame();
  input.endFrame();

  input._onKeyUp({ code: 'KeyS' });
  input.beginFrame();
  assert.equal(input.keyHeld('KeyS'), false);
  assert.equal(input.keyReleased('KeyS'), true);

  input.endFrame();
  assert.equal(input.keyReleased('KeyS'), false);
  input.beginFrame();
  assert.equal(input.keyReleased('KeyS'), false, 'must not reappear on a later idle frame');
});

test('two edges of the same key inside one un-drained window are not silently lost — documented semantics: both the press and the release edge surface, "held" reflects the final live state', () => {
  const input = new Input();
  // press, release, press again, all before the next beginFrame() drains
  // anything — e.g. a very fast tap-tap between two rendered frames.
  input._onKeyDown({ code: 'KeyQ', repeat: false });
  input._onKeyUp({ code: 'KeyQ' });
  input._onKeyDown({ code: 'KeyQ', repeat: false });

  input.beginFrame();
  assert.equal(input.keyPressed('KeyQ'), true, 'a press edge occurred and must not vanish');
  assert.equal(input.keyReleased('KeyQ'), true, 'a release edge occurred and must not vanish');
  assert.equal(input.keyHeld('KeyQ'), true, 'net state after the sequence is down');
});

test('pointer position is sampled exactly once per frame: a move between beginFrame() and endFrame() does not perturb the already-latched snapshot', () => {
  const input = new Input();
  input._onPointerMove({ clientX: 10, clientY: 20 });
  input.beginFrame();
  assert.deepEqual(input.pointer, { x: 10, y: 20 });

  // Movement mid-frame — e.g. arriving while fixedUpdate/update are running.
  input._onPointerMove({ clientX: 999, clientY: 999 });
  assert.deepEqual(input.pointer, { x: 10, y: 20 }, 'this frame\'s snapshot must be unaffected');

  input.endFrame();
  assert.deepEqual(input.pointer, { x: 10, y: 20 }, 'endFrame must not touch the pointer snapshot either');

  input.beginFrame();
  assert.deepEqual(input.pointer, { x: 999, y: 999 }, 'only the next beginFrame() may adopt the new position');
});

test('wheel deltaY accumulates between beginFrame() calls and re-latches to 0 on an idle frame', () => {
  const input = new Input();
  input._onWheel({ deltaY: 5, preventDefault() {} });
  input._onWheel({ deltaY: 3, preventDefault() {} });
  input.beginFrame();
  assert.equal(input.wheelDeltaY, 8);

  input.endFrame();
  input.beginFrame(); // no wheel events this window
  assert.equal(input.wheelDeltaY, 0);
});

test('pointer buttons mirror the key held/pressed/released semantics', () => {
  const input = new Input();
  input._onPointerDown({ clientX: 1, clientY: 1, button: 2 }); // RMB
  input.beginFrame();
  assert.equal(input.buttonHeld(2), true);
  assert.equal(input.buttonPressed(2), true);

  input.endFrame();
  assert.equal(input.buttonHeld(2), true);
  assert.equal(input.buttonPressed(2), false);

  input._onPointerUp({ clientX: 1, clientY: 1, button: 2 });
  input.beginFrame();
  assert.equal(input.buttonHeld(2), false);
  assert.equal(input.buttonReleased(2), true);
});

test('an out-of-range button or a never-seen key code reads as false, never throws', () => {
  const input = new Input();
  assert.equal(input.buttonHeld(99), false);
  assert.equal(input.buttonPressed(-1), false);
  assert.equal(input.keyHeld('NoSuchCode'), false);
  assert.equal(input.keyReleased('NoSuchCode'), false);
});

test('blur releases every held key and button (11-flows.md §12.3 #1) — nothing is stuck down across a focus change', () => {
  const input = new Input();
  input._onKeyDown({ code: 'KeyW', repeat: false });
  input._onPointerDown({ clientX: 0, clientY: 0, button: 0 });
  input.beginFrame();
  assert.equal(input.keyHeld('KeyW'), true);
  assert.equal(input.buttonHeld(0), true);

  input._onBlur();
  input.beginFrame();
  assert.equal(input.keyHeld('KeyW'), false, 'a key held across a focus change must not stay stuck down');
  assert.equal(input.keyReleased('KeyW'), true);
  assert.equal(input.buttonHeld(0), false);
  assert.equal(input.buttonReleased(0), true);

  // And it stays released afterwards — blur does not leave a phantom edge
  // that fires again on some later frame.
  input.endFrame();
  input.beginFrame();
  assert.equal(input.keyReleased('KeyW'), false);
  assert.equal(input.buttonReleased(0), false);
});

test('blur on a key that was never pressed is a no-op, not a fabricated release', () => {
  const input = new Input();
  input.beginFrame();
  input._onBlur();
  input.beginFrame();
  assert.equal(input.keyReleased('KeyW'), false);
});

// --- The constructive prohibition -----------------------------------------
//
// This is the ticket's central acceptance criterion: pointer/key state is
// sampled once per frame, and fixedUpdate — which runs strictly between one
// beginFrame() and the next — has no way to observe anything that happens
// after the snapshot was assembled. There is no live-input accessor on
// `Input` at all: every public read (`keyHeld`, `pointer`, ...) resolves
// only against fields `beginFrame()` last wrote. The test below proves that
// by hammering the raw/private path (exactly what a real DOM event does)
// throughout an entire simulated frame and showing the public snapshot never
// moves until the next beginFrame() call — i.e. a hypothetical fixedUpdate
// call sitting anywhere between beginFrame() and endFrame() would read the
// identical, frozen answer no matter when in that window it ran.

test('fixedUpdate cannot read live input by construction: raw events arriving anywhere inside a beginFrame()..endFrame() window never change that window\'s snapshot', () => {
  const input = new Input();
  input._onKeyDown({ code: 'KeyW', repeat: false });
  input._onPointerMove({ clientX: 1, clientY: 1 });
  input.beginFrame();

  const snapshotAtStart = {
    held: input.keyHeld('KeyW'),
    pointer: { ...input.pointer },
  };

  // Simulate everything that can happen between beginFrame() and endFrame()
  // in a real frame() call — up to MAX_SUBSTEPS=6 fixedUpdate calls plus
  // arbitrary DOM events racing in from the browser — by reading the
  // snapshot repeatedly while mutating the raw buffer in between reads.
  for (let step = 0; step < 6; step++) {
    input._onPointerMove({ clientX: 100 + step, clientY: 100 + step });
    if (step === 2) input._onKeyUp({ code: 'KeyW' });
    if (step === 4) input._onKeyDown({ code: 'KeyW', repeat: false });

    assert.equal(input.keyHeld('KeyW'), snapshotAtStart.held, `fixedUpdate-equivalent read #${step} must see the frame-start value`);
    assert.deepEqual(input.pointer, snapshotAtStart.pointer, `fixedUpdate-equivalent read #${step} must see the frame-start pointer`);
  }

  input.endFrame();
  // Still frozen — endFrame() only clears one-shot edges of what was
  // already latched, it does not re-sample the raw buffer either.
  assert.equal(input.keyHeld('KeyW'), snapshotAtStart.held);
  assert.deepEqual(input.pointer, snapshotAtStart.pointer);

  // Only the *next* beginFrame() is allowed to move the snapshot, and it
  // reflects everything that piled up in the raw buffer meanwhile.
  input.beginFrame();
  assert.deepEqual(input.pointer, { x: 105, y: 105 }); // last move was step 5: 100+5
  assert.equal(input.keyHeld('KeyW'), true); // net raw state: up then down again
});

// --- attach()/detach() -------------------------------------------------

test('attach() wires the target\'s pointerdown/wheel/contextmenu listeners; detach() removes them', () => {
  const input = new Input();
  const target = makeFakeTarget();

  input.attach(target);
  assert.equal(target._listenerCount('pointerdown'), 1);
  assert.equal(target._listenerCount('wheel'), 1);
  assert.equal(target._listenerCount('contextmenu'), 1);

  target._dispatch('pointerdown', { clientX: 5, clientY: 6, button: 0 });
  input.beginFrame();
  assert.equal(input.buttonHeld(0), true);
  assert.deepEqual(input.pointer, { x: 5, y: 6 });
  input.endFrame();

  let prevented = false;
  target._dispatch('contextmenu', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'RMB must not open the browser context menu');

  input.detach();
  assert.equal(target._listenerCount('pointerdown'), 0);
  assert.equal(target._listenerCount('wheel'), 0);
  assert.equal(target._listenerCount('contextmenu'), 0);

  // A dispatch after detach() must not reach Input anymore.
  target._dispatch('pointerdown', { clientX: 50, clientY: 60, button: 1 });
  input.beginFrame();
  assert.equal(input.buttonHeld(1), false);
});

test('attach() rejects a target without addEventListener', () => {
  const input = new Input();
  assert.throws(() => input.attach(null), /addEventListener/);
  assert.throws(() => input.attach({}), /addEventListener/);
});

test('attach() called twice detaches the first target before wiring the second', () => {
  const input = new Input();
  const targetA = makeFakeTarget();
  const targetB = makeFakeTarget();

  input.attach(targetA);
  input.attach(targetB);

  assert.equal(targetA._listenerCount('pointerdown'), 0, 'the first target must be detached');
  assert.equal(targetB._listenerCount('pointerdown'), 1);
});

test('detach() without a prior attach() does not throw', () => {
  const input = new Input();
  assert.doesNotThrow(() => input.detach());
});
