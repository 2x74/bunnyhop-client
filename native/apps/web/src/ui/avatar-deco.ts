// Supporter avatar decorations (supporter-looks.ts AVATAR_DECOS) round a round avatar. The avatar keeps its own box and
// class; decorated() wraps it in a span of the same size with the ornament on a layer 1.5x that size, centred and
// absolutely placed, so nothing moves when it's added. Styles: ./avatar-deco.css.
// - animate: the profile card, the hover card and the Edit card picker. Everywhere else (boards, the dock, lists of
//   many players) the decoration is drawn still, so a page of supporters costs nothing per frame.
// - Animated layers move by transform / opacity only (compositor), stop under reduced motion and Potato, and pause
//   while the decoration is off screen (fxVisibility).

import "./avatar-deco.css";
import { avatarDecoDef, avatarDecoOf, DECO_DEFS, decoMotion, decoPlace, type DecoLayer } from "../supporter-looks";
import { nameColorHex, type PlayerMarks } from "../creators";
import { h } from "./dom";

let uid = 0;

/**
 * The looping layers' clock (card-fx.css, avatar-deco.css, profile.css: animation-delay: var(--fx-t)): how long the
 * page has been up, as a negative delay, so a layer created now starts where one created at page load would be by
 * now. Cards are rebuilt all the time (every Edit card and Support preview, every hover card): a rebuilt card's lights,
 * sparks and ornaments carry on from where the last one's were instead of starting over.
 */
export const fxClock = (): string => `--fx-t:-${((typeof performance !== "undefined" ? performance.now() : 0) / 1000).toFixed(2)}s`;

/** `avatar` wrapped with the player's decoration (unchanged when they have none). */
export function decorated(avatar: HTMLElement, p: Pick<PlayerMarks, "avatarDeco" | "nameColor"> | null | undefined, o: { animate?: boolean; watch?: boolean } = {}): HTMLElement {
  const id = avatarDecoOf(p?.avatarDeco);
  if (!id) return avatar;
  const d = avatarDecoDef(id);
  const color = nameColorHex(p?.nameColor) ?? d.accent;
  // Each instance its own gradient id: a document can hold many, and one inside a hidden subtree mustn't break the rest.
  const gid = `dg${++uid}`;
  const defs = DECO_DEFS.replace('id="dg"', `id="${gid}"`);
  const layers = d.layers.map((l) => {
    const html = `<svg viewBox="0 0 120 120" focusable="false">${defs}${l.svg.replaceAll("url(#dg)", `url(#${gid})`)}</svg>`;
    // .av-anim: every moving span (the card's off-screen watch finds them by it). A placed layer (supporter-looks.ts
    // DecoLayer.place) is two spans: the fixed placement outside, the motion inside it; a second move (DecoLayer.inner,
    // Hopper's hop) is one more span inside the motion.
    // (A layer's own delay rides on the page's clock: card-fx.ts fxClock, avatar-deco.css.)
    const motionOf = (m: DecoLayer | NonNullable<DecoLayer["inner"]>) =>
      m.anim && o.animate ? { class: `av-anim av-${m.anim}`, style: decoMotion(m as DecoLayer).replace(/animation-delay:(-?[\d.]+)s/, "animation-delay:calc(var(--fx-t, 0s) + $1s)") || undefined } : {};
    const motion = motionOf(l);
    const body = l.inner && o.animate ? { html: undefined, inner: h("span.av-deco-a", { html, ...motionOf(l.inner) }) } : { html, inner: null };
    const place = decoPlace(l);
    if (!place) return h("span.av-deco-l", { "aria-hidden": "true", html: body.html, ...motion }, body.inner);
    return h("span.av-deco-l", { "aria-hidden": "true", style: place.css }, h("span.av-deco-a", { html: body.html, ...motion }, body.inner));
  });
  const wrap = h(`span.av-deco.av-deco-${id}`, { style: o.animate ? `color:${color};${fxClock()}` : `color:${color}` }, avatar, ...layers);
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
