// Phones and tablets in the Wavedash build. Wavedash's mobile apps run games that declare no touch or controller
// controls under an emulated keyboard and mouse, and bunnyhopping needs a real one (the site says the same: browse on a
// phone, play on a computer). So a touch-only device gets one plain notice before anything else: a link to copy, and
// "Continue anyway" for a tablet with a keyboard and mouse attached. Nothing on the site.

import { WAVEDASH, WAVEDASH_GAME_URL } from "./env";
import { wavedashCopy } from "./wavedash";
import { h } from "../ui/dom";
import "./touch.css";

let dismissed = false;

/** The device has a coarse pointer and no fine one (a phone or tablet without a mouse). */
const touchOnly = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;

/** The notice is (or will be) up: onboarding waits (ui/account-state.ts onboardingMaybeNeeded). */
export function desktopNoticePending(): boolean {
  return WAVEDASH && !dismissed && touchOnly();
}

/** Shows the notice on a touch-only device (Wavedash build). */
export function showDesktopNotice(): void {
  if (!desktopNoticePending()) return;
  const d = h("dialog.wd-touch", { "aria-label": "bunnyhop.lol needs a keyboard and mouse" }) as HTMLDialogElement;
  const copy = h("button.btn.primary", { type: "button" }, "Copy the link") as HTMLButtonElement;
  copy.addEventListener("click", () => void wavedashCopy(WAVEDASH_GAME_URL).then((ok) => (copy.textContent = ok ? "Link copied" : "Copy the link")));
  const go = h("button.link-btn", { type: "button" }, "Continue anyway");
  go.addEventListener("click", () => ((dismissed = true), d.close()));
  // Esc / the back gesture don't skip it by accident.
  d.addEventListener("cancel", (e) => e.preventDefault());
  d.addEventListener("close", () => d.remove());
  d.append(h("h2", null, "bunnyhop.lol needs a keyboard and mouse"), h("p", null, "Open it on a computer to play."), h("div.wd-touch-actions", null, copy, go));
  document.body.append(d);
  d.showModal();
}
