// The home screen's quiet "Desktop app" link (ui/home.ts) to the desktop client's installer: the API's
// /download/desktop picks the file for this OS (apps/api/src/desktop-download.ts). Not inside the desktop client, not
// on touch devices, and players can hide it (Settings → Account), remembered on this device.

import { API_URL } from "../api";
import { nativeClient } from "../client-bridge";
import { h } from "./dom";
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

function osName(): string | null {
  const p = ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.userAgent).toLowerCase();
  if (p.includes("win")) return "Windows";
  if (p.includes("mac")) return "macOS";
  if (p.includes("linux") && !p.includes("android")) return "Linux";
  return null;
}

/** The "Desktop app" popup: what the client is, the version, and where to get it. */
export function openDesktopApp(): void {
  if (document.querySelector("dialog.desktop-dialog")) return;
  const os = osName();
  const version = h("small.desktop-ver");
  const d = h("dialog.acct-dialog.desktop-dialog", { "aria-label": "Desktop app" }) as HTMLDialogElement;
  const ext = (label: string, href: string) => h("a.link-btn", { href, target: "_blank", rel: "noopener" }, label);
  d.append(
    h("header.acct-head", null, h("h2", null, "Desktop app ", version)),
    h(
      "div.acct-body",
      null,
      h("p", null, "A free, open-source window for bunnyhop.lol on Windows, macOS and Linux. It loads the same game with the same account, and never touches movement or input, so runs count the same as in the browser."),
      h("p", null, "It adds Discord status with Join, maps kept on disk, a run vault, and an F10 menu with display options and a frame-time benchmark."),
      h("p.dim", null, "The builds aren't signed with a paid certificate, so Windows and macOS ask once before the first launch."),
      h(
        "div.desktop-acts",
        null,
        h("a.btn.primary", { href: desktopDownloadUrl(), rel: "noopener" }, os ? `Download for ${os}` : "Download"),
        ext("Other downloads", RELEASES),
        ext("Source code", SOURCE),
      ),
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
