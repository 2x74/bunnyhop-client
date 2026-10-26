// What the unlock card's little 3D model shows for each kind of reward (notify/item3d.ts draws it). DOM- and three-free,
// so apps/api/test/item-preview.test.ts checks the mapping.
//
//   knife       the knife (viewmodel/knives/showcase.ts), in the finish you hold
//   finish      your knife wearing the new finish (the carrot when you hold none)
//   gloves      the open right hand in the glove (viewmodel/gloves/fp.ts geometry, knit follows your colourway)
//   hat         the hat itself (player/bunny/hats.ts)
//   colourway   the bunny in it; ghost colour: your ghost bunny in it
//   trail       a ribbon of a few hops in its colour (player/trail.ts, the in-game trail)
//   title       a small brass nameplate with the title on it (gold for the rank-held ones)
//   badge       the achievement's token as a medal (its ring colour and glyph, ui/badges.ts)
//   frame       a little player card in the frame; background: a little player card on that background

import { fixedModel } from "../player/bunny/look";
import type { AchievementDef, CosmeticDef, Ring } from "../progression";

export type PreviewKind = "knife" | "glove" | "hat" | "bunny" | "ghost" | "trail" | "plaque" | "medal" | "frame" | "card";

export interface PreviewSpec {
  kind: PreviewKind;
  /** Same key, same picture: a prepared model is reused for it. */
  key: string;
  /** knife: knife + finish cosmetic ids. */
  knife?: string;
  finish?: string;
  /** glove: glove cosmetic id; glove / knife / bunny: the colourway (palette, knit gloves, guards). */
  glove?: string;
  outfit?: string;
  body?: string;
  hat?: string;
  /** ghost / trail / frame / card / plaque accent. */
  color?: string;
  /** ghost / trail: the second colour of a two-tone item (the ghost's rim glow, the trail's tail). */
  color2?: string;
  /** bunny: a secret colourway not earned yet, drawn as a flat silhouette (no colours; ui/loadout-view.ts). */
  veil?: boolean;
  /** plaque: the words on it. */
  label?: string;
  /** medal: the token's ring and glyph, and the achievement (ui/badges.ts draws the glyph). */
  ring?: Ring;
  icon?: string;
  achievement?: string;
}

/** What you have on now (player/cosmetics.ts), which the preview dresses the new item with. */
export interface Equipped {
  knife?: string | null;
  finish?: string | null;
  outfit?: string | null;
  body?: string | null;
}

export const DEFAULT_PREVIEW_KNIFE = "knife-carrot";
export const DEFAULT_PREVIEW_FINISH = "fin-garden";
export const DEFAULT_PREVIEW_OUTFIT = "outfit-cream";
const BRASS = "#d9a441";
const GOLD = "#ffd45e";

export type PreviewItem = { cosmetic: CosmeticDef } | { achievement: AchievementDef };

/** The model for a reward, or null when there's nothing sensible to show (the card keeps its flat icon). */
export function previewOf(item: PreviewItem, eq: Equipped = {}): PreviewSpec | null {
  if ("achievement" in item) {
    const a = item.achievement;
    return { kind: "medal", key: `medal:${a.id}`, ring: a.ring, icon: a.icon, achievement: a.id };
  }
  const c = item.cosmetic;
  const knife = eq.knife || DEFAULT_PREVIEW_KNIFE;
  const finish = eq.finish || DEFAULT_PREVIEW_FINISH;
  const outfit = eq.outfit || DEFAULT_PREVIEW_OUTFIT;
  switch (c.slot) {
    case "knife":
      return { kind: "knife", key: `knife:${c.id}:${finish}:${outfit}`, knife: c.id, finish, outfit };
    case "finish":
      return { kind: "knife", key: `knife:${knife}:${c.id}:${outfit}`, knife, finish: c.id, outfit };
    case "glove":
      return { kind: "glove", key: `glove:${c.id}:${outfit}`, glove: c.id, outfit };
    case "hat":
      return { kind: "hat", key: `hat:${c.id}`, hat: c.id };
    case "body":
      return { kind: "bunny", key: `bunny:${outfit}:${c.id}`, outfit, body: c.id };
    case "outfit": {
      const body = fixedModel(c.id) ? "body-a" : eq.body ?? "body-a";
      return { kind: "bunny", key: `bunny:${c.id}:${body}`, outfit: c.id, body };
    }
    case "ghost":
    case "trail":
      if (!c.color) return null;
      // Two-tone items (CosmeticDef.color2: the ghost's rim glow, the trail's tail) carry both.
      return c.color2 ? { kind: c.slot, key: `${c.slot}:${c.color}:${c.color2}`, color: c.color, color2: c.color2 } : { kind: c.slot, key: `${c.slot}:${c.color}`, color: c.color };
    case "title": {
      const color = c.rarity === 5 ? GOLD : BRASS;
      return { kind: "plaque", key: `plaque:${c.name}:${color}`, label: c.name, color };
    }
    case "frame":
      return c.color ? { kind: "frame", key: `frame:${c.id}`, color: c.color } : null;
    case "background":
      return c.color ? { kind: "card", key: `card:${c.id}`, color: c.color } : null;
    default:
      return null;
  }
}

/**
 * Turntable rest pose per kind (radians): `yaw` about the vertical axis from facing the camera, `tilt` towards the
 * camera (positive: looking down on it a little); `fill`: how much of the model's square it fills (its bounding sphere: a
 * long knife needs all of it, a round medal looks right smaller). The hero angle is a 3/4 view; reduced motion shows
 * only it.
 */
export const HERO: Record<PreviewKind, { yaw: number; tilt: number; fill: number }> = {
  knife: { yaw: -0.5, tilt: 0.18, fill: 1 },
  glove: { yaw: 0.1, tilt: 0.2, fill: 0.9 },
  hat: { yaw: -0.55, tilt: 0.32, fill: 0.78 },
  bunny: { yaw: -0.5, tilt: 0.12, fill: 0.95 },
  ghost: { yaw: -0.5, tilt: 0.12, fill: 0.95 },
  trail: { yaw: -0.35, tilt: 0.16, fill: 0.92 },
  plaque: { yaw: -0.42, tilt: 0.12, fill: 0.9 },
  medal: { yaw: -0.45, tilt: 0.1, fill: 0.68 },
  frame: { yaw: -0.45, tilt: 0.12, fill: 0.74 },
  card: { yaw: -0.45, tilt: 0.12, fill: 0.74 },
};

/**
 * The reveal and idle turn, as angles and a scale at `t` ms after the reveal starts (t = Infinity: the rest pose).
 * The item whirls in about 140 degrees and settles into a slow spin with no jolt between the two (the whirl's
 * velocity eases into the spin's), drops a little and grows from 0.35 on `pop` (the scale curve is passed in:
 * spring.ts samples, so it matches the card's emblem pop).
 */
export function turntable(kind: PreviewKind, t: number, pop: (ms: number) => number, idleSpin = 0.5): { yaw: number; tilt: number; scale: number; lift: number } {
  const h = HERO[kind];
  if (!Number.isFinite(t)) return { yaw: h.yaw, tilt: h.tilt, scale: 1, lift: 0 };
  const WHIRL = 2.45;
  const WHIRL_MS = 560;
  const u = Math.min(1, Math.max(0, t / WHIRL_MS));
  const ease = 1 - Math.pow(1 - u, 3);
  // (The trail doesn't spin: a ribbon seen edge-on is a line. Its hops slide through it instead.)
  const spin = kind === "trail" ? 0 : idleSpin;
  const yaw = h.yaw + (spin * Math.max(0, t)) / 1000 - (kind === "trail" ? 0.9 : WHIRL) * (1 - ease);
  const tilt = h.tilt + 0.05 * Math.sin(Math.max(0, t) / 900);
  const p = pop(Math.max(0, t));
  return { yaw, tilt, scale: 0.35 + 0.65 * p, lift: 1 - Math.min(1.2, p) };
}
