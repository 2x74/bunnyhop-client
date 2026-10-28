// Last jump (!ljlast, Settings → HUD → Longjump stats): the last clean jump as a card to copy or save. Local only: no
// submission, no network broadcast, no Discord posting; the player shares it themselves.
import { h } from "../ui/dom";
import { dismissOutside } from "../ui/dismiss";
import { guardSideMouseButtons } from "../binds";
import { toast } from "../notify";
import { takeFreeCursor } from "../free-cursor";
import { resumePlay } from "../play-lock";
import { mapImages } from "../ui/thumbs";
import { me } from "../ui/account-state";
import { styleLabel } from "../styles";
import { ljText } from "./stats";
import { drawJumpCard, type JumpResult } from "./card";
import "./movement.css";

export type { JumpResult } from "./card";

/** The text that goes with it (the copy fallback): the chat line, then where. */
export function jumpSummary(r: JumpResult): string {
  return `${ljText(r.report)}\n${[r.map, r.track ? `Bonus ${r.track}` : "", styleLabel(r.style), r.practice ? "Practice" : ""].filter(Boolean).join(", ")} on bunnyhop.lol`;
}
let last: JumpResult | null = null;
export function rememberJump(r: JumpResult): void { last = structuredClone(r); }
export function forgetJump(): void { last = null; }

/** The map's in-engine hero render (same origin), or null. */
function heroPhoto(map: string): Promise<HTMLImageElement | null> {
  const url = mapImages(map)?.hero;
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok: boolean) => resolve(ok ? img : null);
    const t = setTimeout(() => done(false), 2500);
    img.onload = () => (clearTimeout(t), done(true));
    img.onerror = () => (clearTimeout(t), done(false));
    img.src = url;
  });
}

/** No render for this map: the game view itself (its drawing buffer is kept), unless it's blank (paused behind a menu). */
function gameFrame(): HTMLCanvasElement | null {
  const g = document.getElementById("game") as HTMLCanvasElement | null;
  if (!g || !g.width || !g.height) return null;
  try {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = Math.round((640 * g.height) / g.width);
    const x = c.getContext("2d", { willReadFrequently: true })!;
    x.drawImage(g, 0, 0, c.width, c.height);
    const px = x.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4 * 97) sum += px[i] + px[i + 1] + px[i + 2];
    return sum / (px.length / (4 * 97)) > 24 ? c : null;
  } catch {
    return null;
  }
}

export async function jumpCard(r: JumpResult): Promise<HTMLCanvasElement> {
  const [photo, user] = await Promise.all([heroPhoto(r.map), Promise.race([me().catch(() => null), new Promise<null>((ok) => setTimeout(() => ok(null), 1200))])]);
  try {
    return drawJumpCard(r, { photo: photo ?? gameFrame(), player: user?.name ?? null });
  } catch {
    return drawJumpCard(r, { player: user?.name ?? null });
  }
}

const toBlob = (c: HTMLCanvasElement) => new Promise<Blob | null>((ok) => { try { c.toBlob(ok, "image/png"); } catch { ok(null); } });

let open: HTMLDialogElement | null = null;

/** The Last jump dialog: the card, Copy image and Save image. Play pauses under it, as under !ssj. */
export function openLastJump(): void {
  if (!last) { toast("No jump yet. Turn on Longjump stats in Settings → HUD, then land a clean, same-height jump.", { ms: 5000 }); return; }
  if (open) return;
  const result = structuredClone(last);
  const relock = !!document.pointerLockElement || takeFreeCursor();
  if (document.pointerLockElement) document.exitPointerLock();
  document.body.classList.add("lj-open");
  const d = h("dialog.acct-dialog.lj-dialog", { "aria-label": "Last jump" }) as HTMLDialogElement;
  open = d;
  let viaClick = false;
  const shot = h("div.lj-shot", { role: "img", "aria-label": jumpSummary(result) });
  const status = h("span.lj-status", { "aria-live": "polite" });
  let blob: Promise<Blob | null> = Promise.resolve(null);
  const say = (s: string) => (status.textContent = s);
  const name = `bunnyhop-${result.report.kind.toLowerCase()}-${result.report.distance.toFixed(2)}.png`;
  const copy = h("button.btn.primary", { type: "button", disabled: true, onclick: () => {
    // Safari wants the ClipboardItem in the click itself, with the PNG still on its way.
    const text = async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(jumpSummary(result));
        say("Copied as text");
      } catch {
        say("Couldn't copy. Save the image instead.");
      }
    };
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return void text();
      const png = blob.then((b) => b ?? Promise.reject(new Error("no image")));
      navigator.clipboard.write([new ClipboardItem({ "image/png": png })]).then(() => say("Copied"), () => void text());
    } catch {
      void text();
    }
  } }, "Copy image");
  const save = h("button.btn", { type: "button", disabled: true, onclick: () => void blob.then((b) => {
    if (!b) return say("Couldn't make the image.");
    const url = URL.createObjectURL(b), a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say("Saved");
  }) }, "Save image");
  const close = () => ((viaClick = true), d.close());
  d.append(
    h("header.acct-head", null, h("h2", null, "Last jump"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: close }, "×")),
    h("div.acct-body", null, shot, h("div.lj-actions", null, copy, save, status)),
  );
  void jumpCard(result).then((canvas) => {
    canvas.className = "lj-card";
    shot.replaceChildren(canvas);
    blob = toBlob(canvas);
    copy.disabled = save.disabled = false;
    copy.focus({ preventScroll: true });
  });
  d.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); d.close(); } });
  dismissOutside(d, close);
  const stop = guardSideMouseButtons(window, () => d.open);
  d.addEventListener("close", () => {
    stop();
    d.remove();
    open = null;
    document.body.classList.remove("lj-open");
    // A click takes the pointer back (Esc can't: the pause menu shows, as after any Esc).
    if (relock && viaClick) void resumePlay();
  });
  document.body.append(d);
  d.showModal();
}
