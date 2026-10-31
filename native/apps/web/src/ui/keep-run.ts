// "Keep this run": a guest's first finish or PB, the moment saving their progress matters. Never in the player's way:
// during play the pointer is locked and the HUD takes no input, so the end card only gets one line of text (hud/result.ts
// setKeep), and a field there couldn't be reached or would swallow the restart key. The field itself is in the pause menu,
// where the cursor is free and game keys don't go (input.ts isTextField; the pause keys skip inputs too). It never takes
// focus by itself and lets go of it when play resumes. "Not now" ends it for good, in this browser.

import { WAVEDASH } from "../platform/env";
import { api, ApiError } from "../api";
import { accountChanged, me, openAccount } from "./account-state";
import { passwordForm } from "./account-password";
import { h } from "./dom";
import { toast } from "../notify";

const DISMISSED_KEY = "bunnyhop:keep-run-dismissed";
const LINE = "Keep this run: press Esc and set a password";

let pending = false;
let block: HTMLElement | null = null;
let released = false;
/** Also for this page when storage is blocked (private mode), so "Not now" still holds. */
let saidNo = false;

function dismissed(): boolean {
  if (saidNo) return true;
  try {
    return !!localStorage.getItem(DISMISSED_KEY);
  } catch {
    return false;
  }
}

function dismiss(): void {
  saidNo = true;
  end();
  try {
    localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    /* private mode: gone for this page */
  }
}

/** Done, whichever way: saved, no longer a guest, or "Not now". */
function end(): void {
  pending = false;
  block?.remove();
  block = null;
}

/** A verified first finish or PB: the end card's line, for a guest who hasn't said no. */
export async function keepRunOffer(): Promise<string | null> {
  if (!api.available() || WAVEDASH || dismissed()) return null;
  const u = await me();
  if (u?.provider !== "guest") return null;
  pending = true;
  return LINE;
}

/** The pause menu's block while there's an offer: the same element across redraws, so typing survives them. */
export function keepRunBlock(): HTMLElement | null {
  if (!pending) return null;
  if (block) return block;
  if (!released) {
    released = true;
    // Back in the game with the focus still in a field, every game key would count as typing.
    document.addEventListener("pointerlockchange", () => {
      const a = document.activeElement;
      if (document.pointerLockElement && a instanceof HTMLElement && a.closest(".keep-run")) a.blur();
    });
  }
  const box = (block = h("section.keep-run", { "aria-label": "Keep this run" }, h("h3", null, "Keep this run")));
  const notNow = h("button.link-btn", { type: "button", onclick: dismiss }, "Not now");
  const fail = (e: unknown) => box.append(h("p.es-msg", { role: "alert", "data-kind": "err" }, e instanceof ApiError ? e.message : "Couldn't reach the server."));
  void api.account().then((view) => {
    if (view.user.provider !== "guest") return end();
    // No chosen name yet: the name is the login, so that comes first (the account panel has the name field).
    if (view.name.isDefault) {
      box.append(h("p.es-sub.dim", null, "Pick a name first: it's what you sign in with."), h("div.es-row.pw-actions", null, h("button.btn.primary", { type: "button", onclick: () => openAccount("name") }, "Pick a name"), notNow));
      return;
    }
    box.append(
      passwordForm({
        user: view.user,
        view,
        autofocus: false,
        aside: notNow,
        onDone: (v) => {
          end();
          accountChanged(v.user);
          toast("Saved. Sign in with your name and password on any device.", { ms: 4200 });
        },
      }),
    );
  }, fail);
  return box;
}
