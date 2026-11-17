// The Daily Challenge for a guest (apps/api src/daily.ts: the day's board, its count, the podium and the taking-part
// counts are for accounts; a guest's time is kept and goes on the board when they link or set a password before the
// day's podium is frozen). What a guest is told, and the two ways in the game already has (ui/account-panel.ts):
//   - after a finished daily run: one line under the result (daily/mode.ts), and, like "Keep this run" (ui/keep-run.ts),
//     the actions in the pause menu, where the cursor is free. During play the pointer is locked and the HUD takes no
//     input, so nothing here can get in the way of the next attempt. "Not now" ends it for that day; the line under the
//     result then only says where the time would be;
//   - on the daily screen: one line at the top with the same two actions, gone the moment they have an account.
// One ask at a time: while this one stands, "Keep this run" stands down (keepRunStandDown).

import { forgetDaily, guestPromptText, guestSaidNo, guestSayNo, type GuestTime } from "../daily/state";
import { me, onAccountChange, openAccount } from "./account-state";
import { h } from "./dom";
import { keepRunStandDown } from "./keep-run";

let offer: GuestTime | null = null;
let block: HTMLElement | null = null;

function end(): void {
  offer = null;
  block?.remove();
  block = null;
}

/**
 * A guest's verified daily run: whether the offer stands for it (false: they said "Not now" today, so only the quiet
 * line shows). The latest run's numbers replace an earlier one's.
 */
export function offerDailyGuest(t: GuestTime): boolean {
  if (guestSaidNo(t.day)) return false;
  keepRunStandDown();
  offer = t;
  const text = block?.querySelector(".daily-guest-text");
  if (text) text.textContent = guestPromptText(t);
  return true;
}

/** The pause menu's block while the offer stands: the same element across redraws. */
export function dailyGuestBlock(): HTMLElement | null {
  if (!offer) return null;
  if (block) return block;
  const o = offer;
  const box = (block = h(
    "section.keep-run.daily-guest",
    { "aria-label": "Daily Challenge" },
    h("h3", null, "Put this time on today's board"),
    h("p.es-sub.daily-guest-text", null, guestPromptText(o)),
    h(
      "div.es-row.pw-actions",
      null,
      h("button.btn.primary", { type: "button", "data-part": "link", onclick: () => openAccount("save") }, "Link an account"),
      h("button.btn", { type: "button", "data-part": "password", onclick: () => openAccount("password") }, "Set a password"),
      h("button.link-btn", { type: "button", "data-part": "not-now", onclick: () => (guestSayNo(offer?.day ?? o.day), end()) }, "Not now"),
    ),
  ));
  // With an account the time is on the board: nothing left to ask.
  onAccountChange(box, () => void me().then((u) => u && u.provider !== "guest" && (forgetDaily(), end())));
  return box;
}

/**
 * The daily screen's line for guests: one sentence and the two ways to an account. It stays (it is one line) and goes
 * the moment they have one; `onAccount` then lets the screen read the board again.
 */
export function dailyGuestLine(onAccount: () => void): HTMLElement {
  const el = h(
    "p.dy-guestline",
    { "data-part": "guest", hidden: true },
    "The board shows accounts. ",
    h("button.link-btn", { type: "button", "data-part": "link", onclick: () => openAccount("save") }, "Link an account"),
    " or ",
    h("button.link-btn", { type: "button", "data-part": "password", onclick: () => openAccount("password") }, "set a password"),
    " and your time goes on it, with medals and daily unlocks counting from then on.",
  );
  let guest = false;
  const paint = () =>
    void me().then((u) => {
      const now = u?.provider === "guest";
      el.hidden = !now;
      // (The screen's "finish today's map to unlock" line is an account's: for a guest this line says it.)
      el.closest(".dy")?.classList.toggle("is-guest", now);
      if (guest && !now) {
        forgetDaily();
        onAccount();
      }
      guest = now;
    });
  paint();
  onAccountChange(el, paint);
  return el;
}
