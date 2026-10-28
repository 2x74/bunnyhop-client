// The account panel's platform parts (ui/account-panel.ts):
//   - on the site, signed in: "Keep settings with my account" (platform/settings-sync.ts);
//   - in the Wavedash build: how a player who already has a bunnyhop.lol account brings it here (sign in with its
//     email: the Wavedash player folds into the account, apps/api src/wavedash.ts).
// The site never mentions Wavedash. Styles: ui/account.css.

import { WAVEDASH } from "../platform/env";
import { setSettingsSync, settingsSyncOn } from "../platform/settings-sync";
import { h } from "./dom";

export function platformSections(o: { guest: boolean; hasEmail: boolean }): HTMLElement[] {
  if (WAVEDASH) return o.hasEmail ? [] : [existingAccount()];
  return o.guest ? [] : [syncToggle()];
}

/** Wavedash build: an account from the site comes along by signing in with its email (the row above). */
function existingAccount(): HTMLElement {
  return h(
    "section.acct-sec",
    { id: "acct-existing" },
    h("h3", null, "Already play on bunnyhop.lol?"),
    h("p.acct-note", null, "Sign in with your account's email above and your runs, ranks and unlocks come with you. If you only use Discord there, add an email in Account on bunnyhop.lol first."),
  );
}

/** Site: keep settings with the account. */
function syncToggle(): HTMLElement {
  return h(
    "section.acct-sec",
    { id: "acct-settings" },
    h("h3", null, "Settings"),
    h(
      "label.acct-toggle",
      null,
      h("input.switch", { type: "checkbox", checked: settingsSyncOn(), onchange: (e: Event) => setSettingsSync((e.currentTarget as HTMLInputElement).checked) }),
      h("span.acct-minfo", null, h("b", null, "Keep settings with my account"), h("small.dim", null, "Sensitivity, binds, HUD and graphics follow you to other browsers where this is on (the newest copy wins).")),
    ),
  );
}
