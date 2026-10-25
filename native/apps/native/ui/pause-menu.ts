// The native pause screen: a port of the web's in-game pause menu (apps/web/src/menu.ts pauseScreen), same markup and
// classes so style.css draws it unchanged. The rail on the left (Resume, Restart, places to go, the account), the
// panel on the right with the map's Leaderboard and Style tabs. The last row is the web's Main menu: the host lets go of
// the map and the home screen comes back (Backspace too, and the Main menu bind's key; neither asks, as on the web).
// Practice (web menu.ts: "Practice" / "Leave practice") sits under Restart where practice works; the native client has
// no solo chat to type !cp in, so a Checkpoints row opens the same numbered menu on the HUD.

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
import { ACTIONS, keyLabel } from "../../web/src/ui/settings";

/** The pause menu's own keys (web menu.ts PAUSE_KEYS): a Main menu bind on one of these doesn't leave from here. */
const PAUSE_KEYS = new Set(["Escape", "KeyQ", "KeyE", "Enter", "NumpadEnter", "Space", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);
/** Backspace, plus the Main menu bind's keys that the pause menu doesn't use (web menu.ts mainMenuKeys). */
export const mainMenuKeys = (binds?: Record<string, string[]>): string[] =>
  ["Backspace", ...(binds?.mainMenu ?? []).filter((c) => !c.startsWith("Mouse") && !c.startsWith("MWheel") && !PAUSE_KEYS.has(c))];

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
  /** Main menu: leave the map for the home screen. */
  leave: () => void;
  /** Practice mode's row, where practice works (state.practice.available); null hides it. */
  practice?: { on: boolean; toggle: () => void; checkpoints: () => void; count: number } | null;
  /** Native binds, for the rows' key hints (Practice mode, Main menu). */
  binds?: Record<string, string[]>;
  /** On a bonus track: back to the main track (web "Main track" row). */
  mainTrack?: (() => void) | null;
  /** The Replays tab (web menu.ts replaysTab), over native playback and the local replay library. */
  replayTab?: { watchPB: (() => void) | null; watchLast: (() => void) | null; exportLast: (() => void) | null; load: (file: File) => void };
  /** The On screen tab (web screenTab): the HUD switches players flip most, and the way to the rest. */
  screen?: { values: Record<OnScreenKey, boolean>; set: (key: OnScreenKey, on: boolean) => void; allHud: () => void };
  /** The Help tab's "Every key" link: Settings → Keys. */
  keys?: () => void;
  setStyle: (id: StyleId) => void;
  web: (path: string) => void;
}

type PauseTab = "board" | "style" | "replays" | "screen" | "help";
export type OnScreenKey = "hud" | "crosshair" | "viewmodel" | "jumpStats" | "strafeTrainer";
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

/** Card-style action (web menu.ts actionCard: the Replays tab). */
function actionCard(label: string, fn: (() => void) | null, o: { sub?: string; hint?: string; icon?: IconName; primary?: boolean } = {}): HTMLButtonElement {
  return h(
    `button.action-card${o.primary ? ".primary" : ""}`,
    { type: "button", disabled: !fn, onclick: fn ?? undefined },
    o.icon ? h("span.ac-icon", { "aria-hidden": "true" }, icon(o.icon, { size: "1.2rem" })) : null,
    h("span.ac-text", null, h("b", null, label), o.sub ? h("small", null, o.sub) : null),
    o.hint ? h("kbd", null, o.hint) : null,
  ) as HTMLButtonElement;
}

/** Replays tab (web replaysTab): your PB here, your last run (the local archive), and a .bhr file. */
function replaysTab(a: PauseActions): HTMLElement | null {
  const r = a.replayTab;
  if (!r) return null;
  const pb = getPB(a.map, styleForTrack(a.style, a.track), a.track);
  const input = h("input", { type: "file", accept: ".bhr,application/octet-stream", hidden: true, tabindex: "-1" }) as HTMLInputElement;
  input.addEventListener("change", () => { const file = input.files?.[0]; if (file) r.load(file); input.value = ""; });
  const load = actionCard("Load replay file", () => input.click(), { sub: "From a .bhr file", icon: "upload" });
  load.append(input);
  return h("div.pp-replays", null, h("div.card-grid", null,
    actionCard("Watch PB replay", pb ? r.watchPB : null, { sub: pb ? `${formatTime(pb.time)}, ${pb.jumps} jumps` : "No PB on this track yet", icon: "play", primary: !!(pb && r.watchPB) }),
    actionCard("Watch last run", r.watchLast, { sub: r.watchLast ? undefined : "Finish a run first", icon: "restart" }),
    actionCard("Export last run", r.exportLast, { sub: r.exportLast ? "As a .bhr file, to Downloads" : "Finish a run first", icon: "download" }),
    load));
}

const ON_SCREEN: readonly { key: OnScreenKey; label: string; desc: string }[] = [
  { key: "hud", label: "HUD", desc: "Speed, timer and keys." },
  { key: "crosshair", label: "Crosshair", desc: "The crosshair in the middle of the screen." },
  { key: "viewmodel", label: "Viewmodel", desc: "Your first-person hands and the carrot blade." },
  { key: "jumpStats", label: "Jump stats", desc: "Speed and gain per jump (!ssj)." },
  { key: "strafeTrainer", label: "Strafe trainer", desc: "Turn rate against the ideal for your speed, in the air." },
];

/** On screen tab (web screenTab): one click each for the HUD pieces players switch most; the game behind shows it. */
function screenTab(a: PauseActions): HTMLElement | null {
  const s = a.screen;
  if (!s) return null;
  const rows = ON_SCREEN.map((q) => {
    const input = h("input.switch", { type: "checkbox", checked: s.values[q.key], "aria-label": q.label }) as HTMLInputElement;
    input.addEventListener("change", () => s.set(q.key, input.checked));
    const row = h("div.nset-row.nset-row-toggle", null, h("span.nset-name", null, q.label, h("small.nset-hint", null, q.desc)), input);
    row.addEventListener("click", (e) => { if (e.target !== input) input.click(); });
    return row;
  });
  return h("div.pp-screen", null,
    h("div.nset-group", null, h("div.nset-group-rows", null, ...rows)),
    h("div.pp-screen-foot", null, h("button.link-btn", { type: "button", onclick: s.allHud }, "All HUD settings", icon("chevronRight", { size: "0.95em" }))));
}

/** Help tab (web helpTab, the !help groups): your keys for the run, practice and the screen. Native solo play has no
 * chat, so the commands column shows only what the menu does for them. */
function helpTab(a: PauseActions): HTMLElement {
  const label = (id: string) => ACTIONS.find((x) => x.id === id)?.label ?? id;
  const key = (id: string) => { const c = a.binds?.[id]?.[0]; return c ? keyLabel(c) : ""; };
  const groups: { label: string; rows: { what: string; cmd?: string; key: string }[] }[] = [
    { label: "Run", rows: ["restart", "restartMain", "restartBonus", "cycleStyle", "mainMenu"].map((id) => ({ what: label(id), key: id === "mainMenu" ? key(id) || "Backspace" : key(id), cmd: id === "mainMenu" && !key(id) ? "in this menu" : undefined })) },
    { label: "Practice", rows: [...["practice", "noclip", "cpSave", "cpTeleport", "cpPrev", "cpNext"].map((id) => ({ what: label(id), key: key(id) })), { what: "Checkpoint menu", cmd: "!cp", key: "" }] },
    { label: "Screen", rows: ["hideUi", "viewmodel", "mute"].map((id) => ({ what: label(id), key: key(id) })) },
  ];
  const table = (g: (typeof groups)[number]) => h("section.pp-help-group", null, h("h3", null, g.label),
    h("table.keys-table", null, h("tbody", null, ...g.rows.map((r) => h("tr", null, h("th", null, r.what), h("td.pp-help-cmd", null, r.cmd ?? ""), h("td", null, r.key ? h("kbd", null, r.key) : ""))))));
  return h("div.pp-help", null, h("div.pp-help-cols", null, ...groups.map(table)),
    h("div.pp-screen-foot", null, h("span.dim", null, "Checkpoints opens the !cp menu on screen: 1–6 pick, 0 closes."),
      a.keys ? h("button.link-btn", { type: "button", onclick: a.keys }, "Every key", icon("chevronRight", { size: "0.95em" })) : null));
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
  const tabs: PauseTab[] = ["board", "style", ...(a.replayTab ? (["replays"] as const) : []), ...(a.screen ? (["screen"] as const) : []), "help"];
  if (!tabs.includes(pauseTab)) pauseTab = "board";
  const labels: Record<PauseTab, string> = { board: "Leaderboard", style: "Style", replays: "Replays", screen: "On screen", help: "Help" };
  const tabIcons: Record<PauseTab, IconName> = { board: "board", style: "diamond", replays: "play", screen: "hud", help: "help" };
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
    const content = t === "board" ? leaderboardPanel(a.map, a.style, { tracks: [0, ...(a.track ? [a.track] : [])], track: a.track })
      : t === "style" ? styleTab(a) : t === "replays" ? replaysTab(a) : t === "screen" ? screenTab(a) : helpTab(a);
    panelBody.replaceChildren(...(content ? [content] : []));
  };
  const panel = h("section.pause-panel", { "aria-label": "Pause menu panel" }, h("header.pp-head", null, tabBar), panelBody);

  const homeKey = mainMenuKeys(a.binds);
  const home = railItem("Main menu", a.leave, { hint: keyLabel(homeKey[1] ?? homeKey[0]), icon: "leave" });
  home.classList.add("pause-home");
  const bindHint = (action: string) => { const c = a.binds?.[action]?.[0]; return c ? keyLabel(c) : undefined; };
  const practice = a.practice;
  const sep = () => h("div.rail-sep", { role: "separator" });
  const feedback = api.available() ? railItem("Feedback", () => openFeedback(), { icon: "pen" }) : null;
  const inbox = api.available() ? withInboxBadge(railItem("Inbox", () => openInbox(), { icon: "mail" })) : null;
  const rail = h(
    "nav.rail-list",
    { "aria-label": "Pause menu" },
    railItem("Resume", a.resume, { primary: true, hint: "Esc", icon: "play" }),
    railItem("Restart", a.restart, { hint: a.restartKey ? keyLabel(a.restartKey) : undefined, icon: "restart", sub: a.track ? trackName(a.track) : undefined }),
    a.track && a.mainTrack ? railItem("Main track", a.mainTrack, { hint: bindHint("restartMain"), icon: "home" }) : null,
    practice ? railItem(practice.on ? "Leave practice" : "Practice", practice.toggle, { hint: bindHint("practice"), icon: "flag", sub: practice.on ? "Back to the start" : "Every run is practice" }) : null,
    practice ? railItem("Checkpoints", practice.checkpoints, { icon: "undo", hint: "!cp" }) : null,
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
    home,
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
  // Q / E: previous / next tab from anywhere; Backspace (or the Main menu bind) leaves for the main menu. Only while this
  // menu is what's showing: not under a dialog, not in a text box.
  const onKey = (e: KeyboardEvent) => {
    if (!screen.isConnected) return removeEventListener("keydown", onKey);
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t instanceof HTMLInputElement || t?.closest?.("textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
    if (homeKey.includes(e.code)) {
      e.preventDefault();
      a.leave();
      return;
    }
    const k = e.key.toLowerCase();
    if (k !== "q" && k !== "e") return;
    const i = tabs.indexOf(pauseTab);
    show(tabs[(i + (k === "e" ? 1 : -1) + tabs.length) % tabs.length]);
    if ((document.activeElement as HTMLElement)?.closest(".pp-tabs")) focusTab();
  };
  addEventListener("keydown", onKey);
  show(pauseTab);
  return screen;
}
