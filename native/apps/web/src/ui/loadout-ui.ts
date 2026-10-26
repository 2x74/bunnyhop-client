// Loadout items in the UI (Loadout, card editor, unlock celebration, Settings -> Viewmodel): which ones are listed
// (a knife shows once the knife registry can draw it), their swatches (CSS, no WebGL), rarity colours, and the
// item names ("Karrotbit · Nebula").

import "./loadout-ui.css";
import { colourway } from "../player/bunny/palettes";
import { getOutfit } from "../player/cosmetics";
import { achievement, cosmetic, RARITY, type CosmeticDef } from "../progression";
import { availableNow } from "./community";
import { finishStyle, gloveStyle, type CosmeticLoadout } from "../loadout";
import { knifeById } from "../../../native/ui/knife-catalog";
import { h } from "./dom";

/** Knives the registry hasn't built yet stay hidden everywhere (they appear, as new, once they ship). */
export function listedCosmetic(c: CosmeticDef): boolean {
  return c.slot !== "knife" || !!knifeById(c.id);
}

/**
 * Listed AND worth showing to this player: role-held items (the owner's / staff items) only appear for whoever owns
 * them, never as a locked goal for everyone else; so do items from achievements that can't be earned right now
 * (Early Hopper; the Discord server rewards while the bot is off: ui/community.ts availableNow).
 */
export function shownCosmetic(c: CosmeticDef, owned: ReadonlySet<string> | ((c: CosmeticDef) => boolean)): boolean {
  if (!listedCosmetic(c)) return false;
  const ownOnly = c.unlock.kind === "role" || (c.unlock.kind === "achievement" && !availableNow(achievement(c.unlock.id)));
  if (!ownOnly) return true;
  return typeof owned === "function" ? owned(c) : owned.has(c.id);
}

export const isLoadoutSlot = (slot: string): slot is "knife" | "finish" | "glove" => slot === "knife" || slot === "finish" || slot === "glove";

export function rarityOf(c: CosmeticDef | null): { name: string; color: string } | null {
  return c?.rarity ? RARITY[c.rarity] : null;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** CSS background imitating a finish (the swatch is clipped to a blade shape). */
export function finishBackground(id: string | null | undefined): string {
  const f = finishStyle(id);
  switch (f.kind) {
    case "sunset":
      return "radial-gradient(ellipse 40% 18% at 52% 46%, rgba(255, 222, 210, 0.55), transparent), linear-gradient(90deg, #fcd54d 0%, #fb8452 28%, #ef4f80 52%, #9442c8 78%, #3e48b8 100%)";
    case "ember":
      return "radial-gradient(circle at 30% 45%, #ffb43a 0 12%, transparent 32%), radial-gradient(circle at 70% 55%, #f0561a 0 18%, transparent 40%), radial-gradient(circle at 88% 30%, #ffcf5a 0 8%, transparent 22%), linear-gradient(90deg, #2a0d08, #7a1606 60%, #3a120a)";
    case "tigerlily":
      return "radial-gradient(circle at 18% 40%, #6e1008 0 5%, transparent 6%), radial-gradient(circle at 34% 62%, #6e1008 0 4%, transparent 5%), radial-gradient(circle at 50% 36%, #6e1008 0 3.5%, transparent 4.5%), radial-gradient(circle at 26% 22%, #6e1008 0 3%, transparent 4%), linear-gradient(90deg, #ffc25e, #fb7a1c 70%, #f2620c)";
    case "nebula":
      return "radial-gradient(circle at 22% 38%, #fff 0 1.2%, transparent 2%), radial-gradient(circle at 63% 70%, #fff 0 1%, transparent 1.8%), radial-gradient(circle at 82% 30%, #fff 0 1.4%, transparent 2.2%), radial-gradient(circle at 40% 55%, #e0388f 0 10%, transparent 34%), radial-gradient(circle at 70% 45%, #2a46d0 0 12%, transparent 38%), linear-gradient(90deg, #12052a, #3a1270 55%, #0a0420)";
    case "dewweb":
      return "radial-gradient(circle at 56% 50%, transparent 0 22%, #d8e2f2 23% 25%, transparent 26% 46%, #d8e2f2 47% 48%, transparent 49%), linear-gradient(45deg, transparent 49%, #c8d4ea 49.5% 50.5%, transparent 51%), linear-gradient(-45deg, transparent 49%, #c8d4ea 49.5% 50.5%, transparent 51%), linear-gradient(90deg, #070c26, #26265a)";
    case "frost":
      return "repeating-linear-gradient(62deg, transparent 0 9px, rgba(255, 255, 255, 0.55) 9px 10px), repeating-linear-gradient(-48deg, transparent 0 13px, rgba(255, 255, 255, 0.4) 13px 14px), linear-gradient(90deg, #6aa6dc, #bfe0fa 55%, #8cc0ea)";
    case "heartbeet":
      return "repeating-radial-gradient(ellipse at 55% 50%, #4a0414 0 4px, #a8063a 4px 9px, #f26a9e 9px 11px), #a8063a";
    case "fourleaf":
      return "radial-gradient(circle at 24% 42%, #5ed06a 0 6%, transparent 7%), radial-gradient(circle at 30% 50%, #5ed06a 0 6%, transparent 7%), radial-gradient(circle at 62% 56%, #ffc23d 0 5.5%, transparent 6.5%), radial-gradient(circle at 68% 48%, #ffc23d 0 5.5%, transparent 6.5%), radial-gradient(circle at 84% 38%, #5ed06a 0 4%, transparent 5%), linear-gradient(90deg, #063a16, #0f7a32 60%, #075224)";
    case "founder":
      return "linear-gradient(100deg, transparent 38%, rgba(255, 246, 210, 0.85) 48%, transparent 58%), radial-gradient(circle at 30% 60%, #a8400a 0 16%, transparent 40%), linear-gradient(90deg, #c8761a, #ffc23d 35%, #fff0b0 55%, #ffb02a 75%, #b85a10)";
    case "goldleaf":
      return "radial-gradient(ellipse 30% 40% at 30% 50%, #ffd36a 0 60%, transparent 62%), radial-gradient(ellipse 22% 35% at 70% 40%, #e7a92e 0 60%, transparent 62%), radial-gradient(ellipse 14% 25% at 88% 64%, #ffd36a 0 60%, transparent 62%), linear-gradient(90deg, #0d0b0a, #1a1410)";
    case "aurora":
      return "repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.07) 0 1px, transparent 1px 4px), linear-gradient(0deg, #3ff0a0 0%, rgba(63, 240, 160, 0.55) 30%, rgba(154, 107, 255, 0.45) 60%, transparent 85%), #070d22";
    case "geode":
      return "linear-gradient(180deg, #141218 0 13%, #d6cff5 13% 16%, transparent 16% 84%, #d6cff5 84% 87%, #141218 87%), repeating-linear-gradient(58deg, rgba(255, 255, 255, 0.2) 0 5px, transparent 5px 11px), repeating-linear-gradient(-62deg, rgba(0, 0, 0, 0.25) 0 6px, transparent 6px 13px), linear-gradient(90deg, #3fe6d2, #3fa6e8 55%, #6a4be0)";
    case "rift":
      return "linear-gradient(180deg, #4ff0dc 0 7%, transparent 7%), linear-gradient(168deg, transparent 43%, #7a3cff 45%, #e6fffb 47%, #7a3cff 49%, transparent 52%), linear-gradient(16deg, transparent 57%, #8f5cff 59.5%, transparent 62%), linear-gradient(90deg, #07030f, #1d0b3a 60%, #07030f)";
    case "spectrum":
      return "radial-gradient(circle, transparent 1.3px, #050508 1.9px) 0 0 / 5px 5px, linear-gradient(90deg, #19f2d9, #2a6cff 32%, #7a3cff 62%, #eef6ff 82%, #19f2d9)";
    case "contour":
      return "repeating-radial-gradient(ellipse 140% 90% at 40% 60%, transparent 0 7px, #efe6cf 7px 8px, transparent 8px 15px, #ff8a2a 15px 16px, transparent 16px 23px), linear-gradient(90deg, #2c3e57, #36506e)";
    case "meteor":
      return "linear-gradient(160deg, transparent 30%, #fff3d6 31%, #ff8a2a 33%, rgba(255, 90, 31, 0) 38%), linear-gradient(160deg, transparent 58%, #ffe0b0 59%, #ff5a1f 60.5%, rgba(255, 90, 31, 0) 64%), linear-gradient(90deg, #121216, #1e1e24)";
    case "hourglass":
      return "repeating-linear-gradient(100deg, rgba(120, 80, 40, 0.25) 0 3px, transparent 3px 9px), linear-gradient(90deg, #ecd39e, #c99a5c 70%, #b8834a)";
    case "lantern":
      return "radial-gradient(circle at 30% 30%, #ffd27a 0 1.5%, transparent 2.5%), radial-gradient(circle at 70% 22%, #ffd27a 0 1.2%, transparent 2%), linear-gradient(0deg, #ff8a1f 0%, rgba(255, 138, 31, 0.35) 30%, transparent 60%), #1c111e";
    case "wildflower":
      return "radial-gradient(circle at 22% 40%, #f2b13a 0 3%, #ffffff 3.5% 9%, transparent 9.5%), radial-gradient(circle at 55% 62%, #f2b13a 0 3%, #b79be8 3.5% 8%, transparent 8.5%), radial-gradient(circle at 82% 35%, #f2b13a 0 2.5%, #ffe58a 3% 7%, transparent 7.5%), linear-gradient(90deg, #d8ebc0, #b9d79a)";
    case "tally":
      return "repeating-linear-gradient(90deg, #3b3a40 0 1.5px, transparent 1.5px 5px, #3b3a40 5px 6.5px, transparent 6.5px 10px, #3b3a40 10px 11.5px, transparent 11.5px 15px, #3b3a40 15px 16.5px, transparent 16.5px 26px) 0 30% / 100% 40% no-repeat, #efe9dc";
    case "devgrid":
      return "linear-gradient(90deg, rgba(255, 255, 255, 0.9) 1px, transparent 1px) 0 0 / 8px 8px, linear-gradient(0deg, rgba(255, 255, 255, 0.9) 1px, transparent 1px) 0 0 / 8px 8px, linear-gradient(90deg, #f08a24 0 50%, #8f9296 50%)";
    default:
      return "repeating-linear-gradient(90deg, #ff7a1a 0 9px, #d95a0c 9px 11px)";
  }
}

/** Swatch for a knife / finish / glove item (tile size). */
export function loadoutSwatch(c: CosmeticDef | null, slot: "knife" | "finish" | "glove"): HTMLElement {
  const rar = rarityOf(c)?.color ?? "#888";
  if (slot === "finish") return h("span.pf-sw.pf-sw-fin", { "aria-hidden": "true", style: `--fin:${finishBackground(c?.id)};--rar:${rar}` }, h("span"));
  if (slot === "glove") {
    const g = gloveStyle(c?.id);
    const knit = g.style === "knit";
    const cw = colourway(getOutfit());
    const [a, b, t, s] = knit ? [cw.glove, cw.glove, cw.glove, cw.accent] : [g.base, g.fingers, g.tips, g.strap];
    return h("span.pf-sw.pf-sw-glove", { "aria-hidden": "true", style: `--a:${hex(a)};--b:${hex(b)};--t:${hex(t)};--s:${hex(s)}` }, h("i.f1"), h("i.f2"), h("i.f3"), h("i.palm"));
  }
  return h("span.pf-sw.pf-sw-knife", { "aria-hidden": "true", style: `--sw:${c?.color ?? "#ff7a1a"};--rar:${rar}` }, h("span"));
}

/** "Karrotbit", "Nebula", "Sport · Pandora" (each finish is one design, so its name says it all). */
export function loadoutSummary(l: CosmeticLoadout): { knife: string; finish: string; glove: string } {
  const knife = knifeById(l.knife) ? (cosmetic(l.knife)?.name ?? "Carrot Blade") : "Carrot Blade";
  return { knife, finish: cosmetic(l.finish)?.name ?? "Garden Fresh", glove: cosmetic(l.glove)?.name ?? "Knit" };
}

/** The Loadout menu item's second line (home, offline): "Karrotbit", "Karrotbit · Nebula". */
export function loadoutMenuSub(l: CosmeticLoadout): string {
  const s = loadoutSummary(l);
  return s.finish === "Garden Fresh" ? s.knife : `${s.knife} · ${s.finish}`;
}
