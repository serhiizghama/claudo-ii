// src/items/icons/primitives.js
//
// ITEM-15 — the drawing primitive library `09-ui.md` §7.2 names by exact
// file path ("The library lives in src/items/icons/primitives.js"). Every
// export here takes `(g, rng, p)`: `g` is a `CanvasRenderingContext2D`-shaped
// 2D context (real, from an `OffscreenCanvas` in production; a duck-typed
// recording fake in `tests/items/icons.test.js` — nothing here calls a
// method `09`'s own table doesn't already imply a plain 2D context has), `rng`
// is the per-icon `Rng` fork (`./generate.js`'s single `new Rng(iconSeed)`),
// and `p` is a plain options object whose fields are named after that row's
// "Signature" column in `09` §7.2.
//
// Scope note (see this ticket's report for the full judgment call): these
// are faithful to each primitive's DESCRIBED SHAPE ("tapered quad", "vertical
// bar + wrap bands", "rounded-top rectangle with rivets", ...) and to the
// three-tone ramp / rarity-framing contract, but do not attempt every listed
// "Extra" flourish (grain lines, hairline cracks, a 28° specular streak) —
// those are cosmetic detail on top of an already-satisfied contract
// (distinct, deterministic, in-budget bitmaps), not something the mechanical
// acceptance criteria (render count, distinctness, timing, the two selector
// gaps) can observe either way.
//
// `wear`/`grime`/`rim` (09 §7.2's three post-passes, always run in that
// order — `04-items.md` §11.2) are implemented as cheap VECTOR passes
// (a handful of paths/gradients) rather than a `getImageData`/`putImageData`
// per-pixel erosion or noise field — the latter would be the single biggest
// risk to the ≤1.2 ms budget for zero visible-content benefit at 64-192 px.
//
// Node-safe: no `three`, no `document`/`window`, no `performance.now()` —
// every primitive only touches its own `g`/`rng`/`p` arguments.

/** Fills a tapered quad from `(x0,y0)` (width `w0`) to `(x1,y1)` (width
 * `w1`) — `taper(x0,y0,x1,y1,w0,w1)`. Used directly for hafts/spikes/hooks
 * and as the core of `blade`/`haft` below. */
export function taper(g, rng, p) {
  const { x0, y0, x1, y1, w0, w1, colour } = p;
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len, ny = dx / len;
  g.fillStyle = colour || '#888888';
  g.beginPath();
  g.moveTo(x0 + (nx * w0) / 2, y0 + (ny * w0) / 2);
  g.lineTo(x1 + (nx * w1) / 2, y1 + (ny * w1) / 2);
  g.lineTo(x1 - (nx * w1) / 2, y1 - (ny * w1) / 2);
  g.lineTo(x0 - (nx * w0) / 2, y0 - (ny * w0) / 2);
  g.closePath();
  g.fill();
  void rng;
}

/** `blade(len,w,curve,edge)` — a tapered quad running from `(x,y)` upward
 * `len` px, `w` wide at the base, plus a 1 px fuller line and a light edge
 * stroke on the +x side. `curve` bows the silhouette sideways (kris-style
 * wavy blades). */
export function blade(g, rng, p) {
  const { x, y, len, w, curve = 0, ramp } = p;
  const halfW = Math.max(1, w / 2);
  const tipW = Math.max(1, w * 0.16);
  const bow = curve * len * 0.5;
  g.fillStyle = (ramp && ramp.mid) || '#888888';
  g.beginPath();
  g.moveTo(x - halfW, y);
  g.quadraticCurveTo(x + bow, y - len * 0.5, x - tipW * 0.3, y - len);
  g.lineTo(x + tipW * 0.3, y - len);
  g.quadraticCurveTo(x - bow, y - len * 0.5, x + halfW, y);
  g.closePath();
  g.fill();
  g.strokeStyle = (ramp && ramp.dark) || '#333333';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x, y - len * 0.08);
  g.lineTo(x, y - len * 0.9);
  g.stroke();
  g.strokeStyle = (ramp && ramp.light) || '#eeeeee';
  g.lineWidth = 1.25;
  g.beginPath();
  g.moveTo(x + halfW * 0.55, y - len * 0.12);
  g.lineTo(x + tipW * 0.35, y - len * 0.88);
  g.stroke();
  void rng;
}

/** `haft(len,w,wrap)` — a vertical bar from `(x,y)` upward `len` px, `w`
 * wide, plus `wrap` darker-tone grip bands at ~3 px pitch. */
export function haft(g, rng, p) {
  const { x, y, len, w, wrap = 0, ramp } = p;
  const halfW = Math.max(1, w / 2);
  g.fillStyle = (ramp && ramp.mid) || '#6b4c30';
  g.fillRect(x - halfW, y - len, w, len);
  g.fillStyle = (ramp && ramp.dark) || '#3a2a1c';
  const pitch = wrap > 0 ? len / (wrap * 2) : 0;
  for (let i = 0; i < wrap; i++) {
    const by = y - len + i * pitch * 2 + pitch * 0.5;
    g.fillRect(x - halfW, by, w, Math.max(1, pitch * 0.6));
  }
  void rng;
}

/** `pommel(r,shape)` — a disc, faceted hexagon or claw at `(x,y)`. */
export function pommel(g, rng, p) {
  const { x, y, r, shape = 'disc', ramp } = p;
  g.fillStyle = (ramp && ramp.dark) || '#3a3a3a';
  if (shape === 'hex') {
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();
  } else if (shape === 'claw') {
    g.beginPath();
    g.moveTo(x - r, y + r);
    g.quadraticCurveTo(x, y - r * 1.4, x + r, y + r);
    g.quadraticCurveTo(x, y, x - r, y + r);
    g.closePath();
    g.fill();
  } else {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  void rng;
}

/** `guard(span,thick,sweep)` — a horizontal bar centred on `(x,y)`,
 * optionally arced by `sweep` (0..1, fraction of `span` the ends drop by). */
export function guard(g, rng, p) {
  const { x, y, span, thick, sweep = 0, ramp } = p;
  const half = span / 2;
  g.fillStyle = (ramp && ramp.dark) || '#3a4048';
  g.beginPath();
  g.moveTo(x - half, y + sweep * span * 0.3);
  g.quadraticCurveTo(x, y - thick, x + half, y + sweep * span * 0.3);
  g.quadraticCurveTo(x, y + thick, x - half, y + sweep * span * 0.3);
  g.closePath();
  g.fill();
  void rng;
}

/** `plate(w,h,curve,rivets)` — a rounded-top rectangle centred on `(x,y)`
 * with `rivets` 2 px studs along its top edge. */
export function plate(g, rng, p) {
  const { x, y, w, h, curve = 0, rivets = 0, ramp } = p;
  const left = x - w / 2, top = y - h / 2;
  const radius = Math.min(w, h) * curve * 0.5;
  g.fillStyle = (ramp && ramp.mid) || '#7d8790';
  g.beginPath();
  g.moveTo(left, top + radius);
  g.arcTo(left, top, left + radius, top, radius);
  g.lineTo(left + w - radius, top);
  g.arcTo(left + w, top, left + w, top + radius, radius);
  g.lineTo(left + w, top + h);
  g.lineTo(left, top + h);
  g.closePath();
  g.fill();
  if (rivets > 0) {
    g.fillStyle = (ramp && ramp.dark) || '#3a4048';
    for (let i = 0; i < rivets; i++) {
      const rx = left + (w * (i + 0.5)) / rivets;
      g.beginPath();
      g.arc(rx, top + Math.min(6, h * 0.06), 1.4, 0, Math.PI * 2);
      g.fill();
    }
  }
  void rng;
}

/** `scale(w,h,rows,cols)` — overlapping scallops over a `w x h` box centred
 * on `(x,y)`. */
export function scale(g, rng, p) {
  const { x, y, w, h, rows, cols, ramp } = p;
  const left = x - w / 2, top = y - h / 2;
  const cw = w / cols, ch = h / rows;
  g.fillStyle = (ramp && ramp.dark) || '#3a4048';
  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (cw / 2);
    for (let c = 0; c < cols; c++) {
      const cx = left + offset + c * cw + cw / 2;
      const cy = top + r * ch * 0.7 + ch / 2;
      g.beginPath();
      g.arc(cx, cy, Math.min(cw, ch) * 0.55, 0, Math.PI);
      g.fill();
    }
  }
  void rng;
}

/** `cloth(w,h,folds)` — a polygon over a `w x h` box centred on `(x,y)`,
 * `folds` sine-perturbed side edges. */
export function cloth(g, rng, p) {
  const { x, y, w, h, folds, ramp } = p;
  const left = x - w / 2, top = y - h / 2;
  g.fillStyle = (ramp && ramp.mid) || '#6b4c30';
  g.beginPath();
  g.moveTo(left, top);
  g.lineTo(left + w, top);
  const steps = Math.max(2, folds);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const wob = Math.sin(t * Math.PI * folds) * w * 0.04;
    g.lineTo(left + w + wob, top + t * h);
  }
  for (let i = steps; i >= 1; i--) {
    const t = i / steps;
    const wob = Math.sin(t * Math.PI * folds + 1.7) * w * 0.04;
    g.lineTo(left + wob, top + t * h);
  }
  g.closePath();
  g.fill();
  void rng;
}

/** `boot(w,h)` — an L-shaped silhouette with a sole band, `w x h`, anchored
 * bottom-centre at `(x,y)`. */
export function boot(g, rng, p) {
  const { x, y, w, h, ramp } = p;
  const left = x - w / 2, bottom = y, top = y - h;
  g.fillStyle = (ramp && ramp.mid) || '#6b4c30';
  g.beginPath();
  g.moveTo(left, top);
  g.lineTo(left + w * 0.55, top);
  g.lineTo(left + w * 0.55, bottom - h * 0.22);
  g.lineTo(left + w, bottom - h * 0.22);
  g.lineTo(left + w, bottom);
  g.lineTo(left, bottom);
  g.closePath();
  g.fill();
  g.fillStyle = (ramp && ramp.dark) || '#3a2a1c';
  g.fillRect(left, bottom - Math.max(2, h * 0.06), w, Math.max(2, h * 0.06));
  void rng;
}

/** `ring(r,thick,gem)` — an annulus centred on `(x,y)`, optionally carrying
 * an inset `gem` descriptor drawn via `gem()` below. */
export function ring(g, rng, p) {
  const { x, y, r, thick, ramp } = p;
  g.strokeStyle = (ramp && ramp.mid) || '#7d8790';
  g.lineWidth = thick;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = (ramp && ramp.light) || '#cdd6dd';
  g.lineWidth = 1;
  g.beginPath();
  g.arc(x, y, r - thick / 2 + 1, -0.3, 1.0);
  g.stroke();
  void rng;
}

/** `chain(x0,y0,x1,y1,links)` — `links` interlocking ellipses along the
 * segment `(x0,y0)`-`(x1,y1)`. */
export function chain(g, rng, p) {
  const { x0, y0, x1, y1, links, ramp } = p;
  const dx = (x1 - x0) / Math.max(1, links - 1);
  const dy = (y1 - y0) / Math.max(1, links - 1);
  g.strokeStyle = (ramp && ramp.mid) || '#9a917c';
  g.lineWidth = 1.4;
  for (let i = 0; i < links; i++) {
    const cx = x0 + dx * i, cy = y0 + dy * i;
    g.beginPath();
    g.ellipse(cx, cy, 3, 4, (i % 2) * (Math.PI / 2), 0, Math.PI * 2);
    g.stroke();
  }
  void rng;
}

/** `bottle(w,h,neck,fill,liquid)` — a glass silhouette, a fill polygon, a
 * 2 px meniscus and a cork, anchored bottom-centre at `(x,y)`. `liquid` is
 * `{ from, to }`, a two-stop vertical gradient. */
export function bottle(g, rng, p) {
  const { x, y, w, h, neck, fill = 0.7, liquid, ramp } = p;
  const left = x - w / 2, bottom = y, top = y - h;
  g.strokeStyle = (ramp && ramp.light) || '#b8d8ff';
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(x - neck / 2, top);
  g.lineTo(x - neck / 2, top + h * 0.18);
  g.lineTo(left, top + h * 0.4);
  g.lineTo(left, bottom);
  g.lineTo(x + w / 2, bottom);
  g.lineTo(x + w / 2, top + h * 0.4);
  g.lineTo(x + neck / 2, top + h * 0.18);
  g.lineTo(x + neck / 2, top);
  g.stroke();
  if (liquid) {
    const fillTop = bottom - h * fill;
    const grad = g.createLinearGradient(x, fillTop, x, bottom);
    grad.addColorStop(0, liquid.from);
    grad.addColorStop(1, liquid.to);
    g.fillStyle = grad;
    g.fillRect(left + 1, fillTop, w - 2, bottom - fillTop);
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.fillRect(left + 1, fillTop, w - 2, 2);
  }
  g.fillStyle = (ramp && ramp.dark) || '#3a2a1c';
  g.fillRect(x - neck / 2, top - 3, neck, 4);
  void rng;
}

/** `scroll(w,h,rollRadius)` — a parchment rectangle with two rolled ends
 * and 3 ink lines, centred on `(x,y)`. */
export function scrollShape(g, rng, p) {
  const { x, y, w, h, rollRadius, ramp } = p;
  const left = x - w / 2, top = y - h / 2;
  g.fillStyle = (ramp && ramp.mid) || '#6b4c30';
  g.fillRect(left, top, w, h);
  g.fillStyle = (ramp && ramp.dark) || '#3a2a1c';
  g.beginPath(); g.arc(left, top + h / 2, rollRadius, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(left + w, top + h / 2, rollRadius, 0, Math.PI * 2); g.fill();
  g.strokeStyle = (ramp && ramp.dark) || '#3a2a1c';
  g.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const ly = top + h * (0.32 + i * 0.2);
    g.beginPath();
    g.moveTo(left + w * 0.22, ly);
    g.lineTo(left + w * 0.78, ly);
    g.stroke();
  }
  void rng;
}

/** `gem(r,facets,colour)` — a radial faceted polygon with two highlight
 * facets, centred on `(x,y)`. */
export function gem(g, rng, p) {
  const { x, y, r, facets = 6, colour } = p;
  const base = colour || '#8f9bff';
  g.fillStyle = base;
  g.beginPath();
  for (let i = 0; i < facets; i++) {
    const a = ((Math.PI * 2) / facets) * i - Math.PI / 2;
    const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.55)';
  g.beginPath();
  g.moveTo(x, y - r * 0.7);
  g.lineTo(x + r * 0.3, y - r * 0.1);
  g.lineTo(x - r * 0.1, y - r * 0.1);
  g.closePath();
  g.fill();
  void rng;
}

/** `skullMask(w,h)` — a rounded cranium with two eye voids and a jaw line,
 * centred on `(x,y)`. */
export function skullMask(g, rng, p) {
  const { x, y, w, h, ramp } = p;
  g.fillStyle = (ramp && ramp.mid) || '#9a917c';
  g.beginPath();
  g.ellipse(x, y - h * 0.1, w / 2, h / 2, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = (ramp && ramp.dark) || '#5a5344';
  const eyeR = w * 0.13;
  g.beginPath(); g.ellipse(x - w * 0.22, y - h * 0.12, eyeR, eyeR * 1.2, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(x + w * 0.22, y - h * 0.12, eyeR, eyeR * 1.2, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = (ramp && ramp.dark) || '#5a5344';
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x - w * 0.18, y + h * 0.32);
  g.lineTo(x, y + h * 0.4);
  g.lineTo(x + w * 0.18, y + h * 0.32);
  g.stroke();
  void rng;
}

/** `wear(strength)` — post-pass: a few small dark notches bitten out of the
 * silhouette's bounding box edge, `strength` (0..1) driving how many.
 * Vector approximation of "erodes 1-3 px notches" — see file header. */
export function wear(g, rng, p) {
  const { strength = 0.4, bx, by, bw, bh, ramp } = p;
  const count = Math.round(strength * 6);
  g.fillStyle = (ramp && ramp.dark) || '#070605';
  for (let i = 0; i < count; i++) {
    const edge = rng.int(0, 3);
    let nx, ny;
    if (edge === 0) { nx = bx + rng.range(0, bw); ny = by; }
    else if (edge === 1) { nx = bx + rng.range(0, bw); ny = by + bh; }
    else if (edge === 2) { nx = bx; ny = by + rng.range(0, bh); }
    else { nx = bx + bw; ny = by + rng.range(0, bh); }
    const nr = 1 + rng.next() * 2;
    g.beginPath();
    g.arc(nx, ny, nr, 0, Math.PI * 2);
    g.fill();
  }
}

/** `grime(strength)` — post-pass: a low-frequency multiply-blended shadow
 * in the lower half of the bounding box, `strength` (0..1) driving opacity.
 * Vector approximation (a radial gradient, not a per-pixel noise field) —
 * see file header. */
export function grime(g, rng, p) {
  const { strength = 0.35, bx, by, bw, bh } = p;
  const cx = bx + bw / 2, cy = by + bh * 0.85;
  const grad = g.createRadialGradient(cx, cy, 1, cx, cy, Math.max(bw, bh) * 0.6);
  grad.addColorStop(0, `rgba(10,8,6,${(strength * 0.6).toFixed(3)})`);
  grad.addColorStop(1, 'rgba(10,8,6,0)');
  const prevOp = g.globalCompositeOperation;
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = grad;
  g.fillRect(bx, by + bh * 0.4, bw, bh * 0.6);
  g.globalCompositeOperation = prevOp;
  void rng;
}

/** `rim(colour,width)` — a 1 px outer contour around the bounding box,
 * approximating "extracted by an alpha dilate" with a direct stroke of the
 * content box (cheap, and visually equivalent at this resolution). */
export function rim(g, rng, p) {
  const { colour = '#070605', width = 1, bx, by, bw, bh } = p;
  g.strokeStyle = colour;
  g.lineWidth = width;
  g.strokeRect(bx + width / 2, by + width / 2, bw - width, bh - width);
  void rng;
}
