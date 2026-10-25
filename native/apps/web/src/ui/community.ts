// "Join the Discord": the community invite comes from the API (GET /config, the DISCORD_INVITE var). Nothing shows
// until it says there is one, so an empty var (or an offline API) simply hides every link. Used by the home footer, the
// changelog card and the inbox welcome letter; the static /about and /changelog pages use ../site-community.ts. The
// moderator recruiting line (recruitNote) sits next to each of them: "apply" opens the Feedback form on a moderator
// application, which works with or without an invite; only its "or ask in the Discord" half waits for one.

import { api } from "../api";
import { navigate } from "./nav";
import { cleanInvite } from "../creators";
import { openFeedback } from "../feedback/state";
import type { AchievementDef } from "../progression";
import { h } from "./dom";

export const DISCORD_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true" width="1.1em" height="1.1em"><path fill="currentColor" d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.6 0L8.6 3a19.5 19.5 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18a19.7 19.7 0 0 0 6 3l1.3-2a12.7 12.7 0 0 1-2-1l.5-.4a14 14 0 0 0 12.2 0l.5.4-2 1 1.3 2a19.6 19.6 0 0 0 6-3c.5-5.1-.8-9.6-3.6-13.6ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"/></svg>`;

export interface CommunityConfig {
  /** The invite URL, or null (none configured / offline). */
  invite: string | null;
  /** The community server rewards (In the Burrow, Burrow Booster) can be earned: the API's Discord bot grants them. */
  membership: boolean;
}

let config: Promise<CommunityConfig> | null = null;
let known: CommunityConfig | null = null;

/** GET /config, once per page load (offline: asked again next time). */
export function communityConfig(): Promise<CommunityConfig> {
  if (!api.available()) return Promise.resolve({ invite: null, membership: false });
  config ??= api
    .config()
    .then((c) => (known = { invite: cleanInvite(c.discordInvite), membership: c.discordMembership === true }))
    .catch(() => {
      config = null;
      return { invite: null, membership: false };
    });
  return config;
}

/**
 * Whether the server-membership rewards are on, as last loaded (false until GET /config has answered: screens that list
 * them wait for communityConfig() first, e.g. the profile).
 */
export const membershipRewardsOn = (): boolean => known?.membership ?? false;

/**
 * Whether an achievement (and what it unlocks) can be earned right now, so it's listed as a goal for everyone; when not
 * (progression.ts AchievementDef.availability), only players who have it see it.
 */
export function availableNow(a: Pick<AchievementDef, "availability"> | null | undefined): boolean {
  if (!a?.availability || a.availability === "support") return true;
  return a.availability === "discord_server" ? membershipRewardsOn() : false;
}

/** The invite URL, or null (none configured / offline). One request per page load. */
export function discordInvite(): Promise<string | null> {
  return communityConfig().then((c) => c.invite);
}

/**
 * Moderator recruiting, next to every "Join the Discord" (the static pages have it in their HTML):
 * "We're looking for moderators: apply in Feedback, or ask in the Discord." "apply in Feedback" opens the
 * form on a moderator application (beforeApply first, e.g. to close the dialog the line sits in); the Discord half
 * shows only with an invite. Hidden when there's no API (no Feedback either).
 */
export function recruitNote(cls = "recruit-note", o: { beforeApply?: () => void } = {}): HTMLElement {
  const discord = h("a.recruit-link", { target: "_blank", rel: "noopener" }, "Discord") as HTMLAnchorElement;
  const tail = h("span", { hidden: true }, ", or ask in the ", discord);
  const apply = h("button.recruit-link", { type: "button", onclick: () => (o.beforeApply?.(), openFeedback({ category: "application" })) }, "apply in Feedback");
  const p = h(`p.${cls}`, { hidden: !api.available() }, "We're looking for moderators: ", apply, tail, ".");
  void discordInvite().then((url) => {
    if (!url) return;
    discord.href = url;
    tail.hidden = false;
  });
  return p;
}

/** A "Join the Discord" link, hidden until the invite is known (and staying hidden without one). */
export function discordLink(cls = "discord-link", label = "Join the Discord"): HTMLAnchorElement {
  const a = h(`a.${cls}`, { hidden: true, target: "_blank", rel: "noopener", html: `${DISCORD_ICON}<span>${label}</span>` }) as HTMLAnchorElement;
  void discordInvite().then((url) => {
    if (!url) return;
    a.href = url;
    a.hidden = false;
  });
  return a;
}

/** The one quiet "Support bunnyhop.lol" link (pause menu footer): plain text, opens the Support page (ui/support.ts). */
export function supportLink(cls = "support-link"): HTMLAnchorElement {
  const go = (e: Event) => {
    e.preventDefault();
    navigate({ screen: "support" });
  };
  return h(`a.${cls}`, { href: "/?support", onclick: go }, "Support bunnyhop.lol") as HTMLAnchorElement;
}

