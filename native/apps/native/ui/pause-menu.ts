// The native pause screen: a port of the web's in-game pause menu (apps/web/src/menu.ts pauseScreen), same markup and
// classes so style.css draws it unchanged. The rail on the left (Resume, Restart, places to go, the account), the
// panel on the right with the map's Leaderboard and Style tabs. The web's last row, Main menu, is Quit here: the
// native client has no page to go back to.

import { api } from "../../web/src/api";
import { getPB } from "../../web/src/pb";
import { formatTime } from "../../web/src/timer";
import { accountChip, me } from "../../web/src/ui/account";
import { STYLE_DEFS, styleForTrack, styleLabel, type StyleId } from "../../web/src/styles";
import { trackName } from "../../web/src/zones";
import { wordmark } from "../../web/src/ui/brand";
import { icon, type IconName } from "../../web/src/ui/icons";
import { hopIndicator } from "../../web/src/ui/hop";
import { arrowNav, h } from "../../web/src/ui/dom";
import { mapTier, tierBadge } from "../../web/src/ui/maps";
import { leaderboardPanel } from "../../web/src/ui/leaderboard";
import { versionButton } from "../../web/src/ui/changelog";
import { supportLink } from "../../web/src/ui/community";
import { openFeedback } from "../../web/src/feedback/state";
import { openInbox, withInboxBadge } from "../../web/src/inbox/state";
import { keyLabel } from "../../web/src/ui/settings";

export interface PauseActions {
  map: string;
  style: StyleId;
  track: number;
  /** In a multiplayer room (its own screen replaces Play online). */
  room: boolean;
  /** Restart key (the native bind), shown as the row's hint. */
  restartKey?: string;
  resume: () => void;
  restart: () => void;
  servers: () => void;
  maps: () => void;
  learn: () => void;
  loadout: () => void;
  settings: () => void;
  profile: (id: string) => void;
  ranks: () => void;
  replays: () => void;
  quit: () => void;
  setStyle: (id: StyleId) => void;
  web: (path: string) => void;
}

type PauseTab = "board" | "style";
let pauseTab: PauseTab = "board";

interface RailOpts { primary?: boolean; hint?: string; sub?: string; icon?: IconName }
function railItem(label: string, fn: (() => void) | null, o: RailOpts = {}): HTMLElement {
  return h(
    `button.rail-item${o.primary ? ".primary" : ""}`,
    { type: "button", disabled: !fn, onclick: fn ?? undefined, "data-autofocus": o.primary ? "" : undefined },
    o.icon ? h("span.ri-icon", { "aria-hidden": "true" }, icon(o.icon, { size: "1.05rem" })) : null,
    h("span.ri-label", null, label, o.sub ? h("small", null, o.sub) : null),
    o.hint ? h("kbd", null, o.hint) : null,
  );
}

/** Style tab (menu.ts styleTab): one row per style with your PB on this map; bonus tracks are Normal only. */
function styleTab(a: PauseActions): HTMLElement {
  if (a.track) {
    return h("div.pp-style", null, h("div.pp-group", null,
      h("div.pp-group-head", null, h("span.kicker", null, "Style")),
      h("div.style-locked", null, `${trackName(a.track)} · ${styleLabel(styleForTrack(a.style, a.track))}`, h("small.dim", null, " Bonus tracks are always Normal style. Pick Main to choose a style."))));
  }
  const list = h(
    "div.style-list",
    { role: "radiogroup", "aria-label": "Style" },
    ...STYLE_DEFS.map((d) => {
      const pb = getPB(a.map, d.id, 0);
      const on = d.id === a.style;
      return h(
        `button.style-row${on ? ".on" : ""}`,
        { type: "button", role: "radio", "aria-checked": String(on), tabindex: on ? "0" : "-1", "data-style": d.id, onclick: () => a.setStyle(d.id) },
        h("span.sr-short", null, d.short),
        h("span.sr-text", null, h("b", null, d.name), h("small", null, d.rule)),
        h("span.sr-pb", null, h("small", null, "PB"), pb ? h("b", null, formatTime(pb.time)) : h("b.dim", null, "—")),
      );
    }),
  );
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const items = [...list.querySelectorAll<HTMLElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
  });
  return h("div.pp-style", null, h("div.pp-group", null,
    h("div.pp-group-head", null, h("span.kicker", null, "Style", h("span.pp-note", null, " · changing it restarts the run"))),
    list));
}

export function pauseScreen(a: PauseActions): HTMLElement {
  const runStyle = styleForTrack(a.style, a.track);
  const pb = getPB(a.map, runStyle, a.track);
  const tabs: PauseTab[] = ["board", "style"];
  const labels: Record<PauseTab, string> = { board: "Leaderboard", style: "Style" };
  const tabIcons: Record<PauseTab, IconName> = { board: "board", style: "diamond" };
  const tabBar = h(
    "div.pp-tabs",
    { role: "tablist", "aria-label": "Panel" },
    ...tabs.map((t) =>
      h("button.pp-tab", { type: "button", role: "tab", id: `pp-tab-${t}`, "data-ptab": t, "aria-controls": "pause-panel", onclick: () => show(t) },
        h("span.ri-icon", { "aria-hidden": "true" }, icon(tabIcons[t], { size: "1rem" })), labels[t])),
  );
  tabBar.classList.add("hop-host");
  hopIndicator(tabBar, ".pp-tab", { axis: "x", side: "end", inset: 4, selected: ".on" });
  const panelBody = h("div.pp-body", { id: "pause-panel", role: "tabpanel" });
  const show = (t: PauseTab) => {
    const changed = t !== pauseTab || !panelBody.firstElementChild;
    pauseTab = t;
    for (const b of tabBar.querySelectorAll<HTMLElement>(".pp-tab")) {
      const on = b.dataset.ptab === t;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    panelBody.setAttribute("aria-labelledby", `pp-tab-${t}`);
    if (!changed) return;
    panelBody.replaceChildren(t === "board" ? leaderboardPanel(a.map, a.style, { tracks: [0, ...(a.track ? [a.track] : [])], track: a.track }) : styleTab(a));
  };
  const panel = h("section.pause-panel", { "aria-label": "Pause menu panel" }, h("header.pp-head", null, tabBar), panelBody);

  const quit = railItem("Quit", a.quit, { icon: "leave" });
  quit.classList.add("pause-home");
  const sep = () => h("div.rail-sep", { role: "separator" });
  const feedback = api.available() ? railItem("Feedback", () => openFeedback(), { icon: "pen" }) : null;
  const inbox = api.available() ? withInboxBadge(railItem("Inbox", () => openInbox(), { icon: "mail" })) : null;
  const rail = h(
    "nav.rail-list",
    { "aria-label": "Pause menu" },
    railItem("Resume", a.resume, { primary: true, hint: "Esc", icon: "play" }),
    railItem("Restart", a.restart, { hint: a.restartKey ? keyLabel(a.restartKey) : undefined, icon: "restart", sub: a.track ? trackName(a.track) : undefined }),
    sep(),
    railItem(a.room ? "Current room" : "Play online", a.servers, { icon: "globe", sub: api.available() ? undefined : "offline" }),
    railItem("Change map", a.maps, { icon: "grid", sub: a.room ? "leaves the server" : undefined }),
    railItem("Replays", a.replays, { icon: "play" }),
    sep(),
    railItem("Loadout", a.loadout, { icon: "viewmodel" }),
    railItem("Settings", a.settings, { icon: "tune" }),
    railItem("Profile & ranks", () => void me().then((u) => (u ? a.profile(u.id) : a.ranks()), () => a.ranks()), { icon: "account" }),
    feedback || inbox ? sep() : null,
    feedback || inbox ? h("div.rail-pair", null, feedback, inbox) : null,
    h("div.rail-fill", { "aria-hidden": "true" }),
    quit,
  );
  arrowNav(rail, "button");
  rail.classList.add("hop-host");
  hopIndicator(rail, ".rail-item", { inset: 6, rest: () => rail.querySelector<HTMLElement>(".rail-item.primary") });

  const meta = h("p.pause-meta", null, h("span", null, `${a.track ? trackName(a.track) + " · " : ""}${styleLabel(runStyle)}`), pb ? h("span.pause-pb", null, "PB ", h("b", null, formatTime(pb.time))) : null);
  void mapTier(a.map).then((t) => meta.isConnected && meta.prepend(tierBadge(t)), () => {});
  const support = supportLink("pause-support");
  support.onclick = (e) => (e.preventDefault(), a.web("/?support"));
  const left = h(
    "div.pause-rail",
    null,
    h("header.pause-head", null, h("div.pause-top", null, wordmark("sm")), h("h2.pause-map", { title: a.map }, a.map), meta),
    rail,
    h("footer.pause-foot", null, accountChip({ quiet: true }), versionButton(), support),
  );
  const screen = h("section.pause", null, left, panel);

  // → from the rail lands on the panel's tabs, ← / → switch tabs (← from the first returns to the rail), ↓ enters it.
  let lastRail: HTMLElement | null = null;
  rail.addEventListener("focusin", (e) => (lastRail = e.target as HTMLElement));
  const focusTab = () => tabBar.querySelector<HTMLElement>(".pp-tab.on")?.focus({ preventScroll: true });
  const focusRail = () => (lastRail?.isConnected ? lastRail : rail.querySelector<HTMLElement>("button:not([disabled])"))?.focus({ preventScroll: true });
  rail.addEventListener("keydown", (e) => e.key === "ArrowRight" && (e.preventDefault(), e.stopPropagation(), focusTab()), { capture: true });
  tabBar.addEventListener("keydown", (e) => {
    const i = tabs.indexOf(pauseTab);
    if (e.key === "ArrowDown") {
      const first = panelBody.querySelector<HTMLElement>("button:not([disabled]), [href], input, select");
      if (first) (e.preventDefault(), first.focus());
      return;
    }
    const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (j < 0) return focusRail();
    show(tabs[Math.min(j, tabs.length - 1)]);
    focusTab();
  });
  show(pauseTab);
  return screen;
}
