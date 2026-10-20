// Share links (no analytics): maps, runs and profiles have server-rendered pages that unfurl with a card image in
// Discord, X, Slack, iMessage and Reddit (apps/api/src/seo/). Touch devices get the native share sheet, everyone else
// a copied link.

import { toast as notifyToast, whisper } from "../notify";

export const mapUrl = (name: string) => `${location.origin}/maps/${encodeURIComponent(name)}`;
export const runUrl = (runId: string) => `${location.origin}/replay/${encodeURIComponent(runId)}`;
export const playerUrl = (id: string) => `${location.origin}/u/${encodeURIComponent(id)}`;

export interface ShareData {
  url: string;
  /** Title for the share sheet ("bhop_eazy · bunnyhop.lol"). */
  title: string;
  text?: string;
}

/** Shares or copies `d.url`; resolves with a short message for a toast ("Link copied"), or null if cancelled. */
export async function share(d: ShareData): Promise<string | null> {
  const native = typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches;
  if (native) {
    try {
      await navigator.share({ url: d.url, title: d.title, text: d.text });
      return null;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return null;
      // fall through to copying
    }
  }
  try {
    await navigator.clipboard.writeText(d.url);
    return "Link copied";
  } catch {
    // Clipboard blocked (permissions, insecure context): show the link so it can be copied by hand.
    return d.url;
  }
}

/** The last run of this session the server verified (hud.ts); the pause menu offers to share it. */
let lastVerified: string | null = null;
export const noteVerifiedRun = (runId: string) => void (lastVerified = runId || null);
export const lastVerifiedRun = () => lastVerified;

/** share() + the result: a copied link is a whisper ("Copied") out of the control that did it; anything else a notice. */
export async function shareWithToast(d: ShareData, copied = "Link copied", at?: Element | null): Promise<void> {
  const msg = await share(d);
  if (!msg) return;
  if (msg === "Link copied") return whisper(at ? "Copied" : copied, { at, key: "share-copied" });
  notifyToast(msg, { tone: "info", ms: 6000 });
}

/** A small "Share" button (map hero, replay viewer, end-of-run card). */
export function shareButton(cls: string, get: () => ShareData, copied?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.title = "Copy a link to share";
  b.textContent = "Share";
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    void shareWithToast(get(), copied, b);
  });
  return b;
}
