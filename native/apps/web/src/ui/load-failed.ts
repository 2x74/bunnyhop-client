// The one "couldn't load" state for everything that reads the server (Ranks, Stats, Profile, Play online, Gauntlets,
// the boards' pager): a plain title, one sentence on why, Try again. In the boards' state block (.rb-state, boards.css)
// and in neutral ink: nothing the player did went wrong. Four screens had four different looks, one without a retry.
import { ApiError, ApiUnavailable } from "../api";
import { h } from "./dom";

/** The sentence under the title: an unreachable server says so (`unreachable`: a screen's own words for that), the server's own refusal speaks for itself. */
export function failureText(e: unknown, unreachable = "The server can't be reached right now."): string {
  if (e instanceof ApiUnavailable) return unreachable;
  return e instanceof ApiError && e.message ? e.message : "Something went wrong on the way. Try again in a moment.";
}

/** "Couldn't load <what>", why, and a Try again button that runs `retry`. */
export function loadFailed(what: string, retry: () => void, e?: unknown, unreachable?: string): HTMLElement {
  return h(
    "div.rb-state.load-failed",
    { role: "status" },
    h("strong", null, `Couldn't load ${what}`),
    h("span", null, failureText(e, unreachable)),
    h("button.btn", { type: "button", onclick: retry }, "Try again"),
  );
}

/** Something that isn't there (a player id nobody has): one neutral line, nothing to retry. */
export function nothingHere(text: string): HTMLElement {
  return h("div.rb-state.empty", { role: "status" }, h("strong", null, text));
}
