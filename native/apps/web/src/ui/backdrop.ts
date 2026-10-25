// The 3D scene behind the menus (the menu background in attract.ts, or the paused game in main.ts), frozen while a
// full screen covers it (profile, ranks, map browser, servers, ...). A live canvas under a CSS `filter: blur()` (menu
// background) or the overlay's `backdrop-filter` (paused game) is re-blurred on every frame something above it moves,
// so scrolling a long list over it, or a WebGL preview such as the Loadout's, made the GPU redo a full-screen blur
// 60 times a second next to two 3D renders. That was the "jank" on integrated GPUs.
//
// Frozen: the next rendered frame is copied once into #bg-still (softened a little; the overlay's scrim dims it),
// and the render loops skip drawing (their simulation keeps going) until the menu goes back to a screen that shows the
// scene (home, the pause menu, settings with its live previews) or closes. Looks the same; costs nothing per frame.

import { h } from "./dom";

/** How the still is treated: the same look the CSS gave the live canvas. */
export type BackdropLook = "menu" | "game";
// The live canvas has no CSS filter any more (AIRTIME: scrims, not glass); the still is only softened a little so a
// screen over it reads as "in front", and the overlay's scrim does the dimming in both cases.
const LOOK: Record<BackdropLook, { blur: number; filter: string }> = {
  menu: { blur: 4, filter: "none" },
  game: { blur: 4, filter: "none" },
};

const S = {
  want: false,
  look: "menu" as BackdropLook,
  /** Still painted: loops skip drawing. */
  frozen: false,
  /** One frame through anyway (a feedback screenshot). */
  once: false,
  el: null as HTMLCanvasElement | null,
};

function still(): HTMLCanvasElement {
  if (!S.el) {
    S.el = h("canvas#bg-still", { "aria-hidden": "true" }) as HTMLCanvasElement;
    document.body.append(S.el);
  }
  return S.el;
}

const wanted = new Set<() => void>();

/** Renderers without a loop of their own (attract.ts "still" background): draw a frame when a freeze wants one. */
export function onBackdropWanted(fn: () => void): () => void {
  wanted.add(fn);
  return () => wanted.delete(fn);
}

/** Menu screens: freeze (or thaw) the scene behind. Cheap to call on every screen change. */
export function setBackdropFrozen(on: boolean, look: BackdropLook): void {
  if (on === S.want && (!on || S.look === look)) return;
  S.want = on;
  S.look = look;
  // Thawed, or frozen with another look: (re)painted from the next rendered frame.
  if (S.frozen) {
    S.frozen = false;
    document.body.classList.remove("bg-frozen");
  }
  if (on) for (const fn of wanted) fn();
}

/** Render loops: draw this frame? (False while frozen.) */
export function backdropLive(): boolean {
  if (S.once) {
    S.once = false;
    return true;
  }
  return !S.frozen;
}

/** Lets one frame through while frozen (feedback/modal.ts captures the game view). */
export function backdropFrame(): void {
  S.once = true;
}

/**
 * Render loops: call right after drawing a frame into `canvas` (same task: the WebGL drawing buffer still holds it).
 * When a freeze is pending, this frame becomes the still.
 */
export function backdropRendered(canvas: HTMLCanvasElement): void {
  if (!S.want || S.frozen) return;
  const el = still();
  const look = LOOK[S.look];
  // A quarter of the CSS size is plenty for a blurred image (the browser scales it up smoothly).
  const w = Math.max(1, Math.round(innerWidth / 4));
  const ht = Math.max(1, Math.round(innerHeight / 4));
  el.width = w;
  el.height = ht;
  const g = el.getContext("2d");
  if (!g) return;
  const blur = look.blur / 4;
  if (typeof (g as { filter?: unknown }).filter === "string") {
    g.filter = `blur(${blur}px) ${look.filter}`;
    // Drawn a little larger so the blur doesn't pull in transparent edges.
    const m = blur * 2;
    g.drawImage(canvas, -m, -m, w + m * 2, ht + m * 2);
    g.filter = "none";
  } else {
    // No canvas filters (older Safari): the downscale alone blurs; dim it by hand.
    g.drawImage(canvas, 0, 0, w, ht);
    g.fillStyle = "rgba(0,0,0,0.05)";
    g.fillRect(0, 0, w, ht);
  }
  S.frozen = true;
  document.body.classList.add("bg-frozen");
}
