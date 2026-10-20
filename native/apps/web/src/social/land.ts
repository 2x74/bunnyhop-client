// A follow landing on the button you pressed: the button presses back in (the land) and a small amber seal stamps
// onto its corner, two figures when it made you friends (with the stamp's thump), a check for a plain follow (the
// confirm). The seal floats above everything (fixed, outside the button, so a lean clip-path or a redraw of the
// button can't cut it), holds a moment and lifts off. An unfollow is just the land and the back sound.
// Transform / opacity only; under reduced motion or body.potato the seal just shows and goes. Styles: dock.css .fl-*.

import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { uiSound } from "../audio/ui";
import { stamp } from "../notify";
import { spring, SPRINGS, EASE_IN } from "../notify/spring";

const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("potato");
const HOLD_MS = 1300;

export type Landing = "friends" | "following" | "off";

/** `btn` was pressed and the follow is now `kind` (shown at once; the server answers after). */
export function landFollow(btn: Element, kind: Landing): void {
  const still = calm();
  if (!still && btn.isConnected) btn.animate({ scale: ["0.9", "1"] }, spring(SPRINGS.bouncy));
  if (kind === "off") return uiSound("ui_back");
  const r = btn.getBoundingClientRect();
  if (!r.width) return void uiSound("ui_confirm");
  const seal = h(`i.fl-seal.${kind}`, { "aria-hidden": "true", style: `left:${Math.round(r.right - 9)}px;top:${Math.round(r.top - 9)}px` }, icon(kind === "friends" ? "friends" : "check"));
  document.body.append(seal);
  if (kind === "friends") {
    if (still) uiSound("stamp");
    else stamp(seal);
  } else {
    uiSound("ui_confirm");
    if (!still) seal.animate({ transform: ["scale(0.3)", "none"], opacity: [0, 1] }, spring(SPRINGS.bouncy));
  }
  window.setTimeout(() => {
    if (still || !seal.isConnected) return seal.remove();
    seal.animate({ transform: ["none", "translateY(-6px) scale(0.85)"], opacity: [1, 0] }, { duration: 220, easing: EASE_IN, fill: "forwards" }).finished.then(
      () => seal.remove(),
      () => seal.remove(),
    );
  }, HOLD_MS);
}

/** The server said no: the button shakes once (the state has already gone back). */
export function landFailed(btn: Element): void {
  if (calm() || !btn.isConnected) return;
  btn.animate({ transform: ["translateX(0)", "translateX(-4px)", "translateX(3px)", "translateX(-2px)", "translateX(0)"] }, { duration: 280, easing: "ease-out" });
}
