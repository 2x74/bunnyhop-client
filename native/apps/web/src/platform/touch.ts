// Phones and tablets: bunnyhopping needs a real keyboard and mouse. A touch-only device gets one plain notice before
// anything else: a link to copy, and "Continue anyway" for a tablet with a keyboard and mouse attached.
//   Wavedash build: on every launch (Wavedash's mobile apps run games that declare no touch or controller controls
//   under an emulated keyboard and mouse).
//   Site: once per browser, to a first visit only (nothing in this browser says it finished the intro), and the
//   first-visit intro doesn't open on its own there (ui/account-state.ts), since it ends in a map a phone can't play.
//   Measured 10-28 to 11-10: 7 of 276 phone visitors who finished the intro ever finished a run.

import { WAVEDASH, WAVEDASH_GAME_URL } from "./env";
import { wavedashCopy } from "./wavedash";
import { h } from "../ui/dom";
import "./touch.css";

let dismissed = false;
/** Site: the notice was shown in this browser (kept, so it shows once). */
const SEEN_KEY = "bunnyhop:touch-notice";
/** ui/account-state.ts ONBOARDED_KEY (not imported: that module imports this one). */
const ONBOARDED_KEY = "bunnyhop:onboarded";

function stored(key: string): boolean {
  try {
    return !!localStorage.getItem(key);
  } catch {
    return false;
  }
}

/** The device has a coarse pointer and no fine one (a phone or tablet without a mouse). */
export const touchOnly = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;

/** The notice is (or will be) up: onboarding waits (ui/account-state.ts onboardingMaybeNeeded). */
export function desktopNoticePending(): boolean {
  if (dismissed || !touchOnly()) return false;
  return WAVEDASH || (!stored(SEEN_KEY) && !stored(ONBOARDED_KEY));
}

async function copyLink(): Promise<boolean> {
  if (WAVEDASH) return wavedashCopy(WAVEDASH_GAME_URL);
  try {
    await navigator.clipboard.writeText(location.origin + "/");
    return true;
  } catch {
    return false;
  }
}

/** Shows the notice on a touch-only device. */
export function showDesktopNotice(): void {
  if (!desktopNoticePending()) return;
  if (!WAVEDASH) {
    try {
      localStorage.setItem(SEEN_KEY, String(Date.now()));
    } catch {
      /* private mode: shown again next visit */
    }
  }
  const d = h("dialog.wd-touch", { "aria-label": "bunnyhop.lol needs a keyboard and mouse" }) as HTMLDialogElement;
  const copy = h("button.btn.primary", { type: "button" }, "Copy the link") as HTMLButtonElement;
  copy.addEventListener("click", () => void copyLink().then((ok) => (copy.textContent = ok ? "Link copied" : "Copy the link")));
  const go = h("button.link-btn", { type: "button" }, "Continue anyway");
  go.addEventListener("click", () => ((dismissed = true), d.close()));
  // Esc / the back gesture don't skip it by accident.
  d.addEventListener("cancel", (e) => e.preventDefault());
  d.addEventListener("close", () => d.remove());
  d.append(h("h2", null, "bunnyhop.lol needs a keyboard and mouse"), h("p", null, "Open it on a computer to play."), h("div.wd-touch-actions", null, copy, go));
  document.body.append(d);
  d.showModal();
}
