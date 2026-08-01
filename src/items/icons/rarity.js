// src/items/icons/rarity.js
//
// ITEM-15 — rarity framing (`09-ui.md` §7.4) and the item-dependent overlays
// of §7.5 that are baked into the cached bitmap (sockets, unidentified,
// broken — "unusable"/"new" are `ui` CSS treatments per that section's own
// closing rule and are out of scope here).
//
// `RARITY_META` is a local, frozen table — not an import of `./roll.js`'s
// `RARITY_ORDER` — matching the "local, frozen, not imported" precedent
// `src/items/containers.js:88` already documents for the exact same five
// values, so this ticket does not add a new cross-file dependency for one
// small constant list.
//
// Never `shadowBlur` for the glow (`09` §7.4: "never as shadowBlur, which is
// expensive and, at this size, mushy") — every glow below is an inward
// `createRadialGradient`.

const RARITY_META = Object.freeze({
  normal: Object.freeze({ frame: null, glow: null, mark: null }),
  superior: Object.freeze({ frame: { colour: '#e0e0e0', alpha: 0.45, cornersOnly: true }, glow: null, mark: 'bar1' }),
  magic: Object.freeze({ frame: { colour: '#8f9bff', alpha: 0.6, cornersOnly: false }, glow: { colour: '#6a7bff', alpha: 0.22, r: 6 }, mark: 'bar2' }),
  rare: Object.freeze({ frame: { colour: '#ffe066', alpha: 0.75, cornersOnly: false, brackets: 10 }, glow: { colour: '#ffe066', alpha: 0.26, r: 8 }, mark: 'diamondOpen' }),
  unique: Object.freeze({ frame: { colour: '#e0b25a', alpha: 1, double: true, triangles: 4 }, glow: { colour: '#c8973f', alpha: 0.3, r: 10, emberBar: true }, mark: 'diamondFilled' }),
});

function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawGlow(g, meta, w, h) {
  const grad = g.createRadialGradient(w / 2, h / 2, Math.max(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.55);
  grad.addColorStop(0, withAlpha(meta.colour, 0));
  grad.addColorStop(1, withAlpha(meta.colour, meta.alpha));
  g.fillStyle = grad;
  g.fillRect(meta.r, meta.r, w - meta.r * 2, h - meta.r * 2);
  if (meta.emberBar) {
    g.fillStyle = withAlpha(meta.colour, 0.55);
    g.fillRect(2, h - 4, w - 4, 2);
  }
}

function drawFrame(g, meta, w, h) {
  g.lineWidth = meta.double ? 1 : 1;
  if (meta.cornersOnly) {
    const L = 8;
    g.strokeStyle = withAlpha(meta.colour, meta.alpha);
    for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
      g.beginPath();
      g.moveTo(cx, cy + dy * L);
      g.lineTo(cx, cy);
      g.lineTo(cx + dx * L, cy);
      g.stroke();
    }
    return;
  }
  g.strokeStyle = withAlpha(meta.colour, meta.alpha);
  g.strokeRect(0.5, 0.5, w - 1, h - 1);
  if (meta.double) {
    g.strokeRect(2.5, 2.5, w - 5, h - 5);
    g.fillStyle = withAlpha(meta.colour, meta.alpha);
    const t = meta.triangles || 4;
    for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + dx * t, cy);
      g.lineTo(cx, cy + dy * t);
      g.closePath();
      g.fill();
    }
  }
  if (meta.brackets) {
    const b = meta.brackets;
    g.lineWidth = 1.5;
    for (const [cx, cy, dx, dy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
      g.beginPath();
      g.moveTo(cx, cy + dy * b);
      g.lineTo(cx, cy);
      g.lineTo(cx + dx * b, cy);
      g.stroke();
    }
  }
}

function drawMark(g, kind, colour) {
  g.fillStyle = colour;
  if (kind === 'bar1') {
    g.fillRect(3, 3, 8, 3);
  } else if (kind === 'bar2') {
    g.fillRect(3, 3, 8, 3);
    g.fillRect(3, 9, 8, 3);
  } else if (kind === 'diamondOpen') {
    g.strokeStyle = colour;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(8, 2); g.lineTo(14, 8); g.lineTo(8, 14); g.lineTo(2, 8);
    g.closePath();
    g.stroke();
  } else if (kind === 'diamondFilled') {
    g.beginPath();
    g.moveTo(9, 3); g.lineTo(15, 9); g.lineTo(9, 15); g.lineTo(3, 9);
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(0,0,0,0.55)';
    g.beginPath();
    g.moveTo(9, 6); g.lineTo(12, 9); g.lineTo(9, 12); g.lineTo(6, 9);
    g.closePath();
    g.fill();
  }
}

/**
 * Draws `09-ui.md` §7.4's frame/glow/mark for `rarity` into the top-left
 * `(w,h)` of `g`. `normal` is a strict no-op (matches the table's "none/
 * none/none" row) — this is called unconditionally by `./generate.js`, so a
 * `normal`-rarity icon costs nothing extra, which matters for the 305-render
 * timing budget (every fifth icon in the acceptance set is `normal`).
 * @param {CanvasRenderingContext2D} g
 * @param {string} rarity
 * @param {number} w
 * @param {number} h
 */
export function applyRarityFrame(g, rarity, w, h) {
  const meta = RARITY_META[rarity];
  if (!meta) return; // unknown rarity string: explicit no-op, never a throw
  if (meta.glow) drawGlow(g, meta.glow, w, h);
  if (meta.frame) drawFrame(g, meta.frame, w, h);
  if (meta.mark) drawMark(g, meta.mark, meta.frame ? meta.frame.colour : '#ffffff');
}

/**
 * `09-ui.md` §7.5's item-dependent overlays that ARE baked into the cached
 * bitmap (socket row, the unidentified `?`, broken) — "unusable"/"new" are
 * `ui`-side CSS treatments and are correctly never drawn here.
 * @param {CanvasRenderingContext2D} g
 * @param {{ socketCount:number, identified:boolean, durability:number, maxDurability:number }} opts
 * @param {number} w
 * @param {number} h
 */
export function applyOverlays(g, opts, w, h) {
  const socketCount = opts.socketCount | 0;
  if (socketCount > 0) {
    const n = Math.min(6, socketCount);
    const total = n * 10 + (n - 1) * 3;
    let sx = (w - total) / 2 + 5;
    const sy = h - 7;
    for (let i = 0; i < n; i++) {
      g.fillStyle = 'rgba(7,6,5,0.85)';
      g.beginPath();
      g.arc(sx, sy, 5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#8d887c';
      g.lineWidth = 1;
      g.stroke();
      sx += 13;
    }
  }
  if (opts.identified === false) {
    g.fillStyle = 'rgba(7,6,5,0.7)';
    g.beginPath();
    g.arc(w - 8, 8, 8, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#e0e0e0';
    g.font = '10px sans-serif';
    if (typeof g.textAlign !== 'undefined') g.textAlign = 'center';
    if (typeof g.fillText === 'function') g.fillText('?', w - 8, 12);
  }
  if (opts.maxDurability > 0 && opts.durability === 0) {
    g.strokeStyle = 'rgba(200,40,40,0.4)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(w, h);
    g.moveTo(w, 0);
    g.lineTo(0, h);
    g.stroke();
  }
}
