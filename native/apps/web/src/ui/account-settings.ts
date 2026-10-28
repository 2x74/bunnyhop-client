import { SIGN_IN_HELP } from "./account-copy";
// Settings -> Account (registered through ui/settings-registry.ts; imported by main.ts): opens the account panel
// (name, Discord / email sign-in, sign out), the profile flag picker (also in the profile's ⋯ menu), replays the
// first-visit intro and shows / hides the tutorial (it lives at the top of the map list: tutorial/learn.ts). The panel,
// the picker and the intro load on demand.

import { api, lastKnownMe } from "../api";
import { toast } from "../notify";
import { getReplayIntro, myProfile, openAccount, refreshMyProfile } from "./account-state";
import { registerSettingsSection } from "./settings-registry";
import { desktopLinkApplies, desktopLinkHidden, setDesktopLinkHidden } from "./desktop-link";
import { setTutorialHidden, tutorialEnabled, tutorialHidden } from "../tutorial/flag";

registerSettingsSection(
  "account",
  (ui) => [
    ui.group(
      "Account",
      // One row: guests get Sign in (the panel at its sign-in methods), accounts get the panel at their name.
      api.available() && (lastKnownMe()?.provider ?? "guest") === "guest"
        ? ui.actions("Name and sign-in", [ui.button("Sign in", () => openAccount("save"), { primary: true })], {
            desc: SIGN_IN_HELP,
            keywords: "login sign in discord email save progress account link name username rename display nickname",
          })
        : ui.actions("Name and sign-in", [ui.button("Open account", () => openAccount("name"), { primary: true })], {
            desc: "Change your display name (3 a day), see how you sign in, sign out.",
            keywords: "name username rename display nickname sign out logout login sign in discord email account link",
          }),
      api.available()
        ? ui.actions("Profile flag", [ui.button("Choose flag", () => void Promise.all([myProfile(), import("./country-picker")]).then(([p, m]) => m.countryPicker(p?.player.country, () => (refreshMyProfile(), toast("Profile flag saved")))))], {
            desc: "A country flag before your name on leaderboards, your player card and the server scoreboard.",
            keywords: "flag country region nationality profile flag",
          })
        : null,
      ui.actions("Privacy & data", [ui.button("Request data or deletion", () => void import("./privacy").then((m) => m.openPrivacyDialog()))], {
        desc: "Ask the developer for a copy, deletion or correction of your data.",
        keywords: "privacy data delete account export correction GDPR",
      }),
      ui.actions("First-visit intro", [ui.button("Replay the intro", () => getReplayIntro()?.(), { disabled: !getReplayIntro() })], {
        desc: "Name, bunny colourway and mouse sensitivity.",
        keywords: "onboarding tour help sensitivity",
      }),
      desktopLinkApplies()
        ? ui.toggle("Desktop app link", () => !desktopLinkHidden(), (v) => setDesktopLinkHidden(!v), {
            desc: "The \"Desktop app\" link under the home screen's menu, to download the desktop client.",
            keywords: "desktop app client download electron windows mac linux link home",
          })
        : null,
      tutorialEnabled()
        ? ui.toggle("Show the tutorial", () => !tutorialHidden(), (v) => setTutorialHidden(!v), {
            hint: "At the top of the map list",
            desc: "Off: the tutorial leaves the top of the map list and the pause menu. Tutorial, under the menu on the home screen, still opens it.",
            keywords: "tutorial learn to bhop lessons hide show prompt map list pause",
          })
        : null,
    ),
  ],
  { label: "Account", blurb: "", order: 90, icon: "account" },
);
