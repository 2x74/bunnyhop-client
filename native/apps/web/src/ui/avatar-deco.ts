// Supporter avatar decorations (supporter-looks.ts AVATAR_DECOS) round a round avatar. The avatar keeps its own box and
// class; decorated() wraps it in a span of the same size with the ornament on a layer 1.5x that size, centred and
// absolutely placed, so nothing moves when it's added. Styles: ./avatar-deco.css.
// - animate: the profile card, the hover card and the Edit card picker. Everywhere else (boards, the dock, lists of
//   many players) the decoration is drawn still, so a page of supporters costs nothing per frame.
// - Animated layers move by transform / opacity only (compositor), stop under reduced motion and Potato, and pause
//   while the decoration is off screen (fxVisibility).

import "./avatar-deco.css";
import { avatarDecoDef, avatarDecoOf, DECO_DEFS } from "../supporter-looks";
import { nameColorHex, type PlayerMarks } from "../creators";
import { h } from "./dom";

let uid = 0;

/** `avatar` wrapped with the player's decoration (unchanged when they have none). */
export function decorated(avatar: HTMLElement, p: Pick<PlayerMarks, "avatarDeco" | "nameColor"> | null | undefined, o: { animate?: boolean; watch?: boolean } = {}): HTMLElement {
  const id = avatarDecoOf(p?.avatarDeco);
  if (!id) return avatar;
  const d = avatarDecoDef(id);
  const color = nameColorHex(p?.nameColor) ?? d.accent;
  // Each instance its own gradient id: a document can hold many, and one inside a hidden subtree mustn't break the rest.
  const gid = `dg${++uid}`;
  const defs = DECO_DEFS.replace('id="dg"', `id="${gid}"`);
  const layers = d.layers.map((l) =>
    h(`span.av-deco-l${l.anim && o.animate ? `.av-${l.anim}` : ""}`, {
      "aria-hidden": "true",
      html: `<svg viewBox="0 0 120 120" focusable="false">${defs}${l.svg.replaceAll("url(#dg)", `url(#${gid})`)}</svg>`,
    }),
  );
  const wrap = h(`span.av-deco.av-deco-${id}`, { style: `color:${color}` }, avatar, ...layers);
  // watch: false inside a card, whose own registration (ui/card-fx.ts watchCardFx) pauses it with the card.
  if (o.animate && o.watch !== false) fxVisibility(wrap);
  return wrap;
}

// ---------------------------------------------------------------------------------------------
// Off-screen pause, shared with the card layers (ui/card-fx.ts): an element out of view gets .fx-off, which pauses every
// animation under it (avatar-deco.css, card-fx.css). One observer for the page, and it lets go of what's gone (Sol's
// review of v37/supporter, P2-3): cards and avatars are replaced all the time (every Edit card preview redraws the card,
// hover cards come and go, boards re-render), so a target that has left the document is unobserved and forgotten:
//   - at once, by the disposer fxVisibility returns (for owners that know when they replace something);
//   - otherwise by a sweep, run on every new registration and every few seconds while anything is held: a target that
//     was in the document and isn't now, or was registered and never inserted within GRACE_MS, is released.
// So the observer holds the live targets plus at most the last few seconds' unattached ones.

const GRACE_MS = 5000;
let io: IntersectionObserver | null = null;
const held = new Map<Element, { at: number; seen: boolean }>();
let sweepTimer: ReturnType<typeof setTimeout> | 0 = 0;

function release(el: Element): void {
  if (!held.delete(el)) return;
  io?.unobserve(el);
}

/** Releases targets that have left the document (or never joined it in time). Exported for tests. */
export function sweepFx(now = Date.now()): void {
  for (const [el, h] of held) {
    if (el.isConnected) h.seen = true;
    else if (h.seen || now - h.at > GRACE_MS) release(el);
  }
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = held.size ? setTimeout(() => ((sweepTimer = 0), sweepFx()), GRACE_MS) : 0;
}

/** Pauses `el`'s animations while it's off screen. Returns a disposer that releases it at once. */
export function fxVisibility(el: HTMLElement): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      e.target.classList.toggle("fx-off", !e.isIntersecting);
      // Dropped from the document: let go now rather than at the next sweep.
      if (!e.target.isConnected && held.get(e.target)?.seen) release(e.target);
      else if (e.target.isConnected) {
        const h = held.get(e.target);
        if (h) h.seen = true;
      }
    }
  });
  sweepFx();
  held.set(el, { at: Date.now(), seen: el.isConnected });
  io.observe(el);
  if (!sweepTimer) sweepTimer = setTimeout(() => ((sweepTimer = 0), sweepFx()), GRACE_MS);
  return () => release(el);
}

/** How many targets the observer holds (tests, the leak check). */
export const fxHeld = (): number => held.size;
