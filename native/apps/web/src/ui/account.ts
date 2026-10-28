import { SIGN_IN_HELP } from "./account-copy";
// Guest-first account chip: avatar, display name and level; clicking it opens the account panel (ui/account-panel.ts:
// name, sign-in methods, sign out). Guests also get "Sign in", which opens the panel at the sign-in methods.
// Offline (no API): the name is local-only (it is written into replays).

import { api, lastKnownMe, type User } from "../api";
import { navigate } from "./nav";
import { h } from "./dom";
import { accountAvatar, me, myProfile, onAccountChange, openAccount } from "./account-state";
import "./account.css";

const NAME_LOCAL_KEY = "bunnyhop:name"; // also read by session.ts for replay headers

export { me, myProfile, refreshMyProfile, accountChanged } from "./account-state";

export function localName(): string {
  return localStorage.getItem(NAME_LOCAL_KEY) || "player";
}

/** "Lv 4 · Hopper" under the name; clicking opens your profile. */
function levelTag(small: HTMLElement): void {
  void myProfile().then((p) => {
    // (Painted even before the chip is on the page: a screen built for a view transition is attached a frame later.)
    if (!p) return;
    const b = h(
      "button.chip-level",
      { type: "button", title: `${p.level.xp.toLocaleString("en-US")} XP · your profile`, onclick: () => navigate({ screen: "profile", id: p.player.id }) },
      h("b", null, `Lv ${p.level.level}`),
      " · ",
      h("span", { style: `color:${p.rank.group.color}` }, p.rank.group.name),
    );
    small.replaceChildren(b, small.textContent ? ` · ${small.textContent}` : "");
  });
}

/** Renders the account area (chip + "Sign in" for guests). `quiet` drops the "offline" note. */
export function accountChip(o: { quiet?: boolean } = {}): HTMLElement {
  const root = h("div.account", { "aria-live": "polite" });
  const paint = (u: User | null) => {
    const name = u?.name ?? localName();
    const guest = !u || u.provider === "guest";
    // "guest" only while the account is one; how a linked account signs in (Discord, email) isn't shown.
    const tag = h("small", null, guest ? (api.available() || o.quiet ? "guest" : "guest · offline") : "");
    if (api.available()) levelTag(tag);
    const nameBtn = h(
      "button.name-btn",
      { type: "button", title: "Name and account", "aria-label": `${name}: name and account`, onclick: () => openAccount("name") },
      h("span.name-text", null, name),
      h("span.edit-icon", { "aria-hidden": "true" }, "✎"),
    );
    const chip = h(`div.chip.${guest ? "guest-chip" : "user-chip"}`, null, accountAvatar({ id: u?.id ?? null, name, avatarUrl: u?.avatarUrl ?? null }), h("span.chip-col", null, h("span.name-edit", null, nameBtn), tag));
    root.replaceChildren(chip);
    if (guest && api.available()) root.append(h("button.btn.save-progress", { type: "button", title: SIGN_IN_HELP, onclick: () => openAccount("save") }, "Sign in"));
  };
  // First paint: the last player this browser had (not "guest" while the answer is on its way).
  paint(api.available() ? lastKnownMe() : null);
  const load = () =>
    void me().then((u) => {
      if (u && u.name !== localStorage.getItem(NAME_LOCAL_KEY)) localStorage.setItem(NAME_LOCAL_KEY, u.name);
      // Always painted, attached or not: screens built for a view transition (menu.ts render) are attached after this
      // resolves, and skipping the paint then left the chip in its first, signed-out look.
      paint(u);
    });
  load();
  onAccountChange(root, load);
  return root;
}
