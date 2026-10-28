// The settings panel's crosshair preview. Same drawing as web hud.ts renderCrosshair, which upstream moves into a
// leaf module (hud/crosshair.ts); hud.ts itself draws the web game's HUD and stays out of the menu.
import { h } from "../../web/src/ui/dom";
import type { Prefs } from "../../web/src/ui/settings";

export function renderCrosshair(el: HTMLElement, c: Prefs["crosshair"]): void {
  el.replaceChildren();
  el.className = el.className.replace(/\bxh-\S+/g, "").trim() + ` xh-${c.style}${c.outline ? " xh-outline" : ""}`;
  el.style.setProperty("--xh-color", c.color);
  el.style.setProperty("--xh-size", `${c.size}px`);
  el.style.setProperty("--xh-thick", `${c.thickness}px`);
  el.style.setProperty("--xh-gap", `${c.gap}px`);
  el.style.opacity = String(c.alpha);
  const parts: string[] = [];
  if (c.style === "cross" || c.style === "cross-dot") parts.push("t", "r", "b", "l");
  if (c.style === "t") parts.push("r", "b", "l");
  if (c.style === "dot" || c.style === "cross-dot") parts.push("dot");
  if (c.style === "circle") parts.push("ring", "dot");
  for (const part of parts) el.append(h(`i.xh-${part}`));
}
