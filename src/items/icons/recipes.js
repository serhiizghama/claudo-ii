// src/items/icons/recipes.js
//
// ITEM-15 — recipe selection (`04-items.md` §11.1's "every base resolves to
// exactly one 09-ui.md §7.3 recipe") and the per-recipe-type drawing
// functions (`09-ui.md` §7.3's table). `selectRecipe` is the pure function
// that carries ruling D-24's fix and is exercised directly, with no canvas
// at all, by `tests/items/icons.test.js`.
//
// ---------------------------------------------------------------------------
// Ruling D-24 — the two `09` §7.3 selector gaps (`04-items.md` §11.3)
// ---------------------------------------------------------------------------
// 1. `mace` now selects `mace_` / `hammer_` / `maul_` — the fix `04` §11.3
//    item 1 asks for. `04`/`04` §14.2 C-4 both say "four maul bases"; the
//    live catalogue (`src/items/data/bases.js`) has exactly THREE:
//    `maul_great_normal`, `maul_ossuary_exceptional`, `maul_anvil_elite` —
//    verified by reading that file directly (see this ticket's report).
//    Shipped as three, the miscount reported, not "corrected" upward by
//    inventing a fourth base this ticket has no grant to add.
// 2. `bow` stays selectable (`weapon.handling === 'bow'`) but is genuinely
//    unreachable: no base in `src/items/data/bases.js` has that handling —
//    `03-combat-math.md` §4.1 excludes bows from the player set. Kept, per
//    `04` §11.3 item 2's own instruction, for post-M9 content.
//
// ---------------------------------------------------------------------------
// Scope: generic recipes, not `04` §11.1's 61 hand-authored parameter deltas
// ---------------------------------------------------------------------------
// `04` §11.1 is a 61-row table of bespoke, hand-AUTHORED per-base
// construction deltas (crescent spans, back-spike positions, rivet/prong
// counts, gem hues, named `haft`/`pommel` shapes...) — data authoring
// against a working primitives library, not a correctness question the
// mechanical acceptance criteria (305 renders, all distinct, in budget, the
// two selector-gap fixes, the dev shot pinned and never blessed) can see
// either way. This ticket ships the ENGINE that would render that table,
// not the table's 61 rows — accepted deliberately, on the record, as this
// milestone's last ticket; not silently. Each recipe below is instead
// driven generically by the THREE fields that are cheap to read off every
// `ItemBase` and that the shared pipeline itself already uses to keep
// same-recipe bases apart (`04` §11.2 / `09` §7.3's own closing line, "two
// Battle Axes... with different steel"): `surface` (the ramp), `tier` (a
// small size-scale multiplier) and `iconSeed` (via the per-icon `Rng` fork
// — jitter in `wear`'s notch count/placement and in a few per-recipe layout
// choices below). Distinctness across all 305 renders is PROVEN, not
// assumed — see `tools/iconbench.mjs`'s hash pass and this ticket's report.
//
// This gap is disclosed a SECOND time, in `src/dev/shots.js`'s `ui_icons`
// entry (both its own header comment and its `description` string) — that
// is where a reader actually meets these icons, and a shot whose
// `description` promises more than its frame/side-effect delivers is
// exactly the O-50 failure mode. Read that entry for the two smaller
// simplifications too (the skipped `-22°` tall-weapon rotation, the
// multiplicative reading of "value ±8%") — not repeated here to avoid the
// two comments drifting apart.

import * as prim from './primitives.js';

/** `04-items.md` §11.2: exceptional/elite bases read as visibly larger and
 * more worked than their normal-tier siblings in the authored deltas (wider
 * crescents, longer hafts, more rivets); this is the one generic knob that
 * captures that without the full per-base table. */
function tierScale(tier) {
  if (tier === 'elite') return 1.14;
  if (tier === 'exceptional') return 1.06;
  return 1.0;
}

// ---------------------------------------------------------------------------
// Recipe selection — `09-ui.md` §7.3's selector column, `(category, slot,
// weapon.handling, baseId prefix)`
// ---------------------------------------------------------------------------

/**
 * @param {object} base - an `ItemBase` (`01-data-model.md` §5.1).
 * @returns {string|null} a key into `RECIPES`, or `null` if nothing selects
 *   this base (`unarmed`, or a category this ticket's recipe set does not
 *   cover) — callers must treat `null` as an explicit "no icon for this
 *   base", never throw.
 */
export function selectRecipe(base) {
  if (!base) return null;
  const id = base.id;
  if (base.category === 'weapon') {
    const w = base.weapon;
    if (!w) return null;
    if (id.startsWith('axe_')) return w.twoHanded ? 'axe2h' : 'axe1h';
    if (id.startsWith('sword_')) return w.twoHanded ? 'sword2h' : 'sword1h';
    // Ruling D-24 fix: mace_ / hammer_ / maul_ all select `mace`.
    if (id.startsWith('mace_') || id.startsWith('hammer_') || id.startsWith('maul_')) return 'mace';
    if (id.startsWith('dagger_')) return 'dagger';
    if (id.startsWith('spear_') || id.startsWith('polearm_')) return 'spear';
    if (w.handling === 'staff') return 'staff';
    if (w.handling === 'wand') return 'wand';
    if (w.handling === 'bow') return 'bow'; // unreachable today — see header
    return null; // unarmed and anything else unmatched
  }
  if (base.category === 'armour') {
    const a = base.armour;
    if (base.slot === 'offHand' && a && a.blockBase > 0) return 'shield';
    if (base.slot === 'head') return 'helm';
    if (base.slot === 'chest') return 'chest';
    if (base.slot === 'hands') return 'gloves';
    if (base.slot === 'legs') return 'boots';
    if (base.slot === 'belt') return 'belt';
    return null;
  }
  if (base.category === 'jewelry') {
    if (id.startsWith('ring_')) return 'ring';
    if (id.startsWith('amulet_')) return 'amulet';
    return null;
  }
  if (base.category === 'consumable') {
    const c = base.consumable;
    if (!c) return null;
    if (c.effect === 'restore_life' || c.effect === 'restore_mana' || c.effect === 'restore_both') return 'potion';
    if (c.effect === 'identify' || c.effect === 'town_portal' || c.effect === 'respec') return 'scroll';
    return null;
  }
  if (base.category === 'quest') return 'quest';
  return null;
}

// ---------------------------------------------------------------------------
// Recipe drawing functions — `(g, rng, ctx)`, `ctx = { bx,by,bw,bh, cx,cy,
// ramp, tier, base }` where `bx/by/bw/bh` is the content box (already inset
// by the 4 px margin `09` §7.3 specifies) and `cx/cy` is its centre.
// ---------------------------------------------------------------------------

function potionLiquid(base) {
  const effect = base.consumable && base.consumable.effect;
  if (effect === 'restore_life') return { from: '#8e1f22', to: '#d24a3c' };
  if (effect === 'restore_mana') return { from: '#1d3a86', to: '#4a86d8' };
  return { from: '#8e1f22', to: '#4a86d8' }; // restore_both (rejuvenation)
}

export const RECIPES = Object.freeze({
  sword1h(g, rng, ctx) {
    const { cx, bx, by, bw, bh, ramp, tier } = ctx;
    const s = tierScale(tier);
    const bottomY = by + bh * 0.84;
    prim.blade(g, rng, { x: cx, y: bottomY, len: bh * 0.62 * s, w: Math.max(4, bw * 0.32), curve: 0.02, ramp });
    prim.guard(g, rng, { x: cx, y: bottomY, span: bw * 0.75, thick: 4, sweep: 0.15, ramp });
    prim.haft(g, rng, { x: cx, y: by + bh, len: bh * 0.13, w: bw * 0.2, wrap: 3, ramp });
    prim.pommel(g, rng, { x: cx, y: by + bh - 1, r: bw * 0.12, shape: 'disc', ramp });
  },
  sword2h(g, rng, ctx) {
    const { cx, bx, by, bw, bh, ramp, tier } = ctx;
    const s = tierScale(tier);
    const bottomY = by + bh * 0.82;
    prim.blade(g, rng, { x: cx, y: bottomY, len: bh * 0.66 * s, w: Math.max(6, bw * 0.42), curve: 0.01, ramp });
    prim.guard(g, rng, { x: cx, y: bottomY, span: bw * 0.95, thick: 6, sweep: 0.25, ramp });
    prim.haft(g, rng, { x: cx, y: by + bh, len: bh * 0.17, w: bw * 0.24, wrap: 5, ramp });
    prim.pommel(g, rng, { x: cx, y: by + bh - 1, r: bw * 0.14, shape: 'disc', ramp });
    void bx;
  },
  axe1h(g, rng, ctx) {
    const { cx, bx, by, bw, bh, ramp, tier } = ctx;
    const s = tierScale(tier);
    const headY = by + bh * 0.24;
    prim.haft(g, rng, { x: cx, y: by + bh, len: bh * 0.92, w: bw * 0.16, wrap: 6, ramp });
    prim.taper(g, rng, { x0: cx, y0: headY, x1: cx + bw * 0.42 * s, y1: headY - bh * 0.12, w0: 4, w1: bh * 0.24 * s, colour: ramp.mid });
    prim.taper(g, rng, { x0: cx, y0: headY, x1: cx + bw * 0.42 * s, y1: headY + bh * 0.12, w0: 4, w1: bh * 0.24 * s, colour: ramp.light });
    prim.pommel(g, rng, { x: cx, y: by + bh - 1, r: bw * 0.1, shape: 'claw', ramp });
    void bx;
  },
  axe2h(g, rng, ctx) {
    const { cx, bx, by, bw, bh, ramp, tier } = ctx;
    const s = tierScale(tier);
    const headY = by + bh * 0.26;
    prim.haft(g, rng, { x: cx, y: by + bh, len: bh * 0.94, w: bw * 0.14, wrap: 7, ramp });
    for (const dir of [-1, 1]) {
      prim.taper(g, rng, { x0: cx, y0: headY, x1: cx + dir * bw * 0.46 * s, y1: headY - bh * 0.14, w0: 4, w1: bh * 0.26 * s, colour: ramp.mid });
      prim.taper(g, rng, { x0: cx, y0: headY, x1: cx + dir * bw * 0.46 * s, y1: headY + bh * 0.14, w0: 4, w1: bh * 0.26 * s, colour: ramp.light });
    }
    void bx;
  },
  mace(g, rng, ctx) {
    const { cx, bx, by, bw, bh, ramp, tier, base } = ctx;
    const s = tierScale(tier);
    const headY = by + bh * 0.24;
    const twoHanded = base.weapon && base.weapon.twoHanded;
    prim.haft(g, rng, { x: cx, y: by + bh, len: bh * (twoHanded ? 0.88 : 0.78), w: bw * (twoHanded ? 0.16 : 0.14), wrap: twoHanded ? 6 : 4, ramp });
    prim.plate(g, rng, { x: cx, y: headY, w: bw * 0.7 * s, h: bh * 0.22 * s, curve: 0.4, rivets: 4, ramp });
    // four flanges, jittered a few degrees per iconSeed so same-recipe/
    // same-surface bases (e.g. mace_flanged_normal vs hammer_edict_elite)
    // still differ pixel-for-pixel, not just in the tint pass.
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI / 2) * i + rng.range(-0.08, 0.08);
      const fx = cx + Math.cos(a) * bw * 0.36 * s;
      const fy = headY + Math.sin(a) * bh * 0.14 * s;
      prim.taper(g, rng, { x0: cx, y0: headY, x1: fx, y1: fy, w0: 2, w1: 5, colour: ramp.dark });
    }
    void bx;
  },
  dagger(g, rng, ctx) {
    const { cx, by, bh, bw, ramp, tier } = ctx;
    const s = tierScale(tier);
    const bottomY = by + bh * 0.8;
    prim.blade(g, rng, { x: cx, y: bottomY, len: bh * 0.6 * s, w: Math.max(3, bw * 0.28), curve: 0.06, ramp });
    prim.guard(g, rng, { x: cx, y: bottomY, span: bw * 0.5, thick: 2.5, sweep: 0, ramp });
    prim.haft(g, rng, { x: cx, y: by + bh, len: bh * 0.18, w: bw * 0.18, wrap: 2, ramp });
  },
  spear(g, rng, ctx) {
    const { cx, by, bh, bw, ramp, tier } = ctx;
    const s = tierScale(tier);
    prim.haft(g, rng, { x: cx, y: by + bh, len: bh * 0.9, w: bw * 0.12, wrap: 8, ramp });
    prim.taper(g, rng, { x0: cx, y0: by + bh * 0.1, x1: cx, y1: by, w0: bw * 0.3 * s, w1: 4, colour: ramp.light });
    prim.taper(g, rng, { x0: cx - bw * 0.18, y0: by + bh * 0.16, x1: cx - bw * 0.28, y1: by + bh * 0.24, w0: 3, w1: 6, colour: ramp.mid });
    prim.taper(g, rng, { x0: cx + bw * 0.18, y0: by + bh * 0.16, x1: cx + bw * 0.28, y1: by + bh * 0.24, w0: 3, w1: 6, colour: ramp.mid });
  },
  staff(g, rng, ctx) {
    const { cx, by, bh, bw, ramp, base } = ctx;
    prim.haft(g, rng, { x: cx, y: by + bh, len: bh * 0.86, w: bw * 0.14, wrap: 6, ramp });
    const prongs = 3;
    for (let i = 0; i < prongs; i++) {
      const spread = (i - (prongs - 1) / 2) * (bw * 0.18);
      prim.taper(g, rng, { x0: cx, y0: by + bh * 0.16, x1: cx + spread, y1: by, w0: 3, w1: 1.5, colour: ramp.dark });
    }
    const seedHue = ((base.iconSeed >>> 8) % 360);
    prim.gem(g, rng, { x: cx, y: by + bh * 0.14, r: bw * 0.16, facets: 6, colour: `hsl(${seedHue},70%,55%)` });
  },
  wand(g, rng, ctx) {
    const { cx, by, bh, bw, ramp } = ctx;
    prim.haft(g, rng, { x: cx, y: by + bh, len: bh * 0.8, w: bw * 0.16, wrap: 3, ramp });
    prim.gem(g, rng, { x: cx, y: by + bh * 0.15, r: bw * 0.18, facets: 5, colour: ramp.light });
  },
  bow(g, rng, ctx) {
    // Unreachable in practice (no base selects it) — kept faithful enough
    // to draw without error if ever called directly (e.g. from a future
    // tool/test exercising the recipe table itself).
    const { cx, by, bh, bw, ramp } = ctx;
    for (const dir of [-1, 1]) {
      prim.taper(g, rng, { x0: cx, y0: by + bh / 2, x1: cx + dir * bw * 0.1, y1: by + (dir < 0 ? 0 : bh), w0: 5, w1: 2, colour: ramp.mid });
    }
    g.strokeStyle = ramp.light;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, by);
    g.lineTo(cx, by + bh);
    g.stroke();
  },
  shield(g, rng, ctx) {
    const { cx, cy, bw, bh, ramp } = ctx;
    prim.plate(g, rng, { x: cx, y: cy, w: bw * 0.92, h: bh * 0.92, curve: 0.5, rivets: 8, ramp });
    prim.ring(g, rng, { x: cx, y: cy, r: Math.min(bw, bh) * 0.14, thick: 3, ramp });
    g.strokeStyle = ramp.dark;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx, cy - bh * 0.4);
    g.lineTo(cx, cy + bh * 0.4);
    g.stroke();
  },
  helm(g, rng, ctx) {
    const { cx, cy, bw, bh, ramp } = ctx;
    prim.skullMask(g, rng, { x: cx, y: cy, w: bw * 0.86, h: bh * 0.86, ramp });
    g.fillStyle = ramp.dark;
    g.fillRect(cx - bw * 0.32, cy - bh * 0.3, bw * 0.64, Math.max(2, bh * 0.06));
  },
  chest(g, rng, ctx) {
    const { cx, cy, bw, bh, ramp, base } = ctx;
    prim.plate(g, rng, { x: cx, y: cy, w: bw * 0.9, h: bh * 0.9, curve: 0.3, rivets: base.tier === 'elite' ? 16 : base.tier === 'exceptional' ? 12 : 8, ramp });
    g.strokeStyle = ramp.dark;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, cy - bh * 0.35);
    g.lineTo(cx, cy + bh * 0.1);
    g.stroke();
    if (base.tier === 'elite') {
      prim.skullMask(g, rng, { x: cx, y: cy + bh * 0.12, w: bw * 0.26, h: bh * 0.2, ramp });
    }
  },
  gloves(g, rng, ctx) {
    const { cx, cy, bw, bh, ramp } = ctx;
    prim.plate(g, rng, { x: cx - bw * 0.16, y: cy, w: bw * 0.48, h: bh * 0.7, curve: 0.4, rivets: 2, ramp });
    prim.plate(g, rng, { x: cx + bw * 0.16, y: cy, w: bw * 0.48, h: bh * 0.7, curve: 0.4, rivets: 2, ramp });
  },
  boots(g, rng, ctx) {
    const { cx, by, bh, bw, ramp } = ctx;
    prim.boot(g, rng, { x: cx - bw * 0.2, y: by + bh, w: bw * 0.5, h: bh * 0.86, ramp });
    prim.boot(g, rng, { x: cx + bw * 0.2, y: by + bh, w: bw * 0.5, h: bh * 0.86, ramp });
  },
  belt(g, rng, ctx) {
    const { cx, cy, bw, bh, ramp } = ctx;
    prim.plate(g, rng, { x: cx, y: cy, w: bw * 0.94, h: bh * 0.7, curve: 0.15, rivets: 4, ramp });
    g.fillStyle = ramp.dark;
    const buckle = Math.min(bw, bh) * 0.28;
    g.fillRect(cx - buckle / 2, cy - buckle / 2, buckle, buckle);
  },
  ring(g, rng, ctx) {
    const { cx, cy, bw, bh, ramp, base } = ctx;
    const r = Math.min(bw, bh) * 0.32;
    prim.ring(g, rng, { x: cx, y: cy, r, thick: 5, ramp });
    if (!base.id.endsWith('_iron')) {
      const seedHue = (base.iconSeed % 360);
      prim.gem(g, rng, { x: cx, y: cy, r: r * 0.5, facets: 6, colour: `hsl(${seedHue},65%,55%)` });
    }
  },
  amulet(g, rng, ctx) {
    const { cx, by, bh, bw, ramp, base } = ctx;
    prim.chain(g, rng, { x0: cx - bw * 0.3, y0: by + bh * 0.14, x1: cx + bw * 0.3, y1: by + bh * 0.14, links: 6, ramp });
    prim.plate(g, rng, { x: cx, y: by + bh * 0.55, w: bw * 0.4, h: bh * 0.44, curve: 0.3, rivets: 0, ramp });
    const seedHue = ((base.iconSeed >>> 4) % 360);
    prim.gem(g, rng, { x: cx, y: by + bh * 0.55, r: Math.min(bw, bh) * 0.14, facets: 6, colour: `hsl(${seedHue},60%,55%)` });
  },
  potion(g, rng, ctx) {
    const { cx, by, bh, bw, base } = ctx;
    const fillLadder = { potion_life_minor: 0.62, potion_mana_minor: 0.62, potion_life_lesser: 0.7, potion_mana_lesser: 0.7, potion_life_greater: 0.78, potion_mana_greater: 0.78, potion_life_grand: 0.86, potion_mana_grand: 0.86 };
    const fill = fillLadder[base.id] !== undefined ? fillLadder[base.id] : 0.7;
    prim.bottle(g, rng, { x: cx, y: by + bh, w: bw * 0.6, h: bh * 0.88, neck: bw * 0.22, fill, liquid: potionLiquid(base) });
  },
  scroll(g, rng, ctx) {
    const { cx, cy, bw, bh, ramp } = ctx;
    prim.scrollShape(g, rng, { x: cx, y: cy, w: bw * 0.8, h: bh * 0.5, rollRadius: bh * 0.1, ramp });
  },
  quest(g, rng, ctx) {
    const { cx, cy, bw, bh, ramp } = ctx;
    prim.plate(g, rng, { x: cx, y: cy, w: bw * 0.86, h: bh * 0.86, curve: 0.1, rivets: 0, ramp });
    g.strokeStyle = ramp.dark;
    g.lineWidth = 1;
    for (let i = 0; i < 5; i++) {
      const ly = cy - bh * 0.28 + i * (bh * 0.14);
      g.beginPath();
      g.moveTo(cx - bw * 0.28, ly);
      g.lineTo(cx + bw * 0.28, ly);
      g.stroke();
    }
  },
});
