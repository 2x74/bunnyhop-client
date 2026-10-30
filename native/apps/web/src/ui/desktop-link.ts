// The home screen's quiet "Desktop app" link (ui/home.ts) to the desktop client's installer: the API's
// /download/desktop picks the file for this OS (apps/api/src/desktop-download.ts). Not inside the desktop client, not
// on touch devices, and players can hide it (Settings → Account), remembered on this device.

import { API_URL } from "../api";
import { nativeClient } from "../client-bridge";
import { h } from "./dom";
import { icon } from "./icons";
import { dismissOutside } from "./dismiss";
import "./account.css";

const KEY = "bunnyhop:desktop-link";

export function desktopLinkHidden(): boolean {
  try { return localStorage.getItem(KEY) === "0"; } catch { return false; }
}
export function setDesktopLinkHidden(hidden: boolean): void {
  try { hidden ? localStorage.setItem(KEY, "0") : localStorage.removeItem(KEY); } catch { /* private mode */ }
}
/** Whether this device could use the link at all (the Settings switch only shows then). */
export function desktopLinkApplies(): boolean {
  return !nativeClient() && !matchMedia("(pointer: coarse)").matches;
}
export function desktopLinkShown(): boolean {
  return desktopLinkApplies() && !desktopLinkHidden();
}
export function desktopDownloadUrl(): string {
  return API_URL ? `${API_URL}/download/desktop` : "https://github.com/8tp/bunnyhop-client/releases/latest";
}

const RELEASES = "https://github.com/8tp/bunnyhop-client/releases/latest";
const SOURCE = "https://github.com/8tp/bunnyhop-client";
/** luna's native client (C++, its own engine around the same game core): the other desktop option. */
const NATIVE_RELEASES = "https://github.com/2x74/bunnyhop-client/releases";

function osName(): string | null {
  const p = ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.userAgent).toLowerCase();
  if (p.includes("win")) return "Windows";
  if (p.includes("mac")) return "macOS";
  if (p.includes("linux") && !p.includes("android")) return "Linux";
  return null;
}

/**
 * One row of the comparison: what it is, platforms, updates, input... A row's cells are the browser's, the desktop app's
 * and the native client's, in that order.
 */
type Cells = [string, string, string];
const ROWS: [string, Cells][] = [
  ["What it is", [
    "The game at bunnyhop.lol. Nothing to install.",
    "The same site in its own window (Electron), with a few extras. Open source, by the bunnyhop.lol team.",
    "A separate client by luna: C++ on the same Rust movement and timer code, menus from the site, no browser.",
  ]],
  ["Platforms", ["Any desktop browser", "Windows, macOS, Linux", "Windows x64, Linux x64, macOS on Apple silicon"]],
  ["Updates", [
    "Always the latest version.",
    "The game is always the latest. The app says when a new app version is out; you install it.",
    "In the app (Settings → Updates) from 0.6.3. On 0.6.2 or older, download the new version once by hand.",
  ]],
  ["Input and frame rate", [
    "Input goes through the browser's event queue, which can hold it back on busy frames.",
    "Chromium set up for games: input reaches the game sooner than in Chrome. F10 has display options and a frame-time benchmark.",
    "No browser in between: the highest frame rates, and the mouse read straight from the OS.",
  ]],
  ["Custom CSS", ["Yes, Settings → Custom CSS", "Yes, and a CSS file it reloads when you save it (F10 → Client)", "Menus only: the in-game HUD is drawn natively"]],
  ["Custom skies", ["Yes, Settings → Graphics → Sky", "Yes, and a skies folder (F10 → Client → Open skies folder)", "No, each map's own sky"]],
  ["Also", ["", "Discord status with Join, maps kept on disk, a run vault", "Beta: expect rough edges. Feedback button in the client."]],
  ["Ranked runs", ["Yes", "Yes, the same as the browser", "Yes, from builds the server has reviewed"]],
];

/**
 * The "Desktop app" popup: the three ways to play side by side (browser, the desktop app, luna's native client), then
 * where to get each. Players mixed the two downloads up (2026-10).
 */
export function openDesktopApp(): void {
  if (document.querySelector("dialog.desktop-dialog")) return;
  const os = osName();
  const version = h("small.desktop-ver");
  const d = h("dialog.acct-dialog.desktop-dialog", { "aria-label": "Ways to play" }) as HTMLDialogElement;
  const ext = (label: string, href: string) => h("a.link-btn", { href, target: "_blank", rel: "noopener" }, label);
  const COLS = ["Browser", "Desktop app", "Native client"];
  const head = h("tr", null, h("td"), ...COLS.map((c, i) => h("th", { scope: "col" }, c, i === 1 ? version : i === 0 ? h("small.desktop-here", null, "you're here") : h("small.desktop-ver", null, "beta"))));
  const row = (what: string, cells: (string | HTMLElement)[]) =>
    h("tr", null, h("th", { scope: "row" }, what), ...cells.map((c, i) => h("td", { "data-col": COLS[i] }, c)));
  d.append(
    h("header.acct-head", null, h("h2", null, "Ways to play"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, icon("close"))),
    h(
      "div.acct-body",
      null,
      h("p.desktop-lede", null, "Same account, maps, leaderboards and settings everywhere. Pick by what you want from it."),
      h(
        "table.desktop-cmp",
        null,
        h("thead", null, head),
        h(
          "tbody",
          null,
          ...ROWS.map(([what, cells]) => row(what, cells)),
          h(
            "tr.desktop-get",
            null,
            h("th", { scope: "row" }, "Get it"),
            h("td", { "data-col": COLS[0] }, h("span.dim", null, "You're playing it")),
            h("td", { "data-col": COLS[1] }, h("a.btn.primary", { href: desktopDownloadUrl(), rel: "noopener" }, os ? `Download for ${os}` : "Download"), h("span.desktop-links", null, ext("Other downloads", RELEASES), ext("Source code", SOURCE))),
            h("td", { "data-col": COLS[2] }, h("a.btn", { href: NATIVE_RELEASES, target: "_blank", rel: "noopener" }, "Native releases")),
          ),
        ),
      ),
      h("p.dim.desktop-note", null, "Neither download is signed with a paid certificate, so Windows and macOS ask once before the first launch."),
    ),
  );
  d.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); d.close(); } });
  dismissOutside(d, () => d.close());
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  if (API_URL)
    void fetch(`${API_URL}/download/desktop/info`).then((r) => r.json()).then((j: { version?: string | null }) => {
      if (j.version) version.textContent = `v${j.version}`;
    }).catch(() => {});
}
