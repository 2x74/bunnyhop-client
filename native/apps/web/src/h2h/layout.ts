// Head to head's layouts (viewer/h2h.ts): where each run's view and its panel go, on screen and in an export frame.
// DOM-free, tested under bun (apps/web/test/h2h.test.ts).
//
//   side     the two views left | right, each run's panel under its own view (16:9)
//   stacked  the two views top / bottom, each run's panel under its own view (9:16, portrait windows); on a landscape
//            screen the panel goes beside its view (on the left)
//   ghost    one view (the other run as a ghost), the two panels side by side under it
//
// Index 0 is the primary run (the left / top view), 1 the other.

export type H2HLayout = "side" | "stacked" | "ghost";
export const H2H_LAYOUTS: readonly H2HLayout[] = ["side", "stacked", "ghost"];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface H2HRects {
  /** One view per run (ghost: one). */
  views: Rect[];
  /** One panel per run, always two. */
  panels: Rect[];
}

/** A layout from a URL's ?view= (split = side, the first version's name), else null. */
export function layoutParam(v: string | null): H2HLayout | null {
  return v === "side" || v === "split" ? "side" : v === "stacked" || v === "ghost" ? v : null;
}

/** The layout a window starts in: ghost on slow graphics, stacked when it's taller than wide, else side by side. */
export function defaultLayout(w: number, h: number, slow: boolean): H2HLayout {
  return slow ? "ghost" : h > w ? "stacked" : "side";
}

/** An export frame's layout: 9:16 stacks the views, 16:9 puts them side by side. */
export function exportLayout(w: number, h: number): H2HLayout {
  return h > w ? "stacked" : "side";
}

/** Panel height for an area: on screen in CSS px, in an export the frame's short side times PANEL_FRAME. */
export const PANEL_FRAME = 0.12;
export function screenPanelHeight(areaH: number, layout: H2HLayout): number {
  const share = layout === "stacked" ? 0.12 : 0.17;
  return Math.round(Math.max(84, Math.min(136, areaH * share)));
}

/** Rectangles inside an area of w x h (origin top left), panels `p` tall. */
export function h2hRects(layout: H2HLayout, w: number, h: number, p: number): H2HRects {
  const W = Math.max(2, Math.round(w));
  const H = Math.max(2, Math.round(h));
  const P = Math.max(0, Math.min(Math.round(p), Math.floor(H / (layout === "stacked" ? 2 : 1)) - 1));
  if (layout === "stacked" && W > H * 1.3 && P > 0) {
    // Stacked on a landscape screen: each run's panel beside its view (under it, the views would be slivers).
    const half = Math.floor(H / 2);
    const pw = Math.round(Math.max(300, Math.min(480, W * 0.28)));
    return {
      views: [
        { x: pw, y: 0, w: W - pw, h: half },
        { x: pw, y: half, w: W - pw, h: H - half },
      ],
      // On the left: the viewer's close and help buttons sit at the top right.
      panels: [
        { x: 0, y: 0, w: pw, h: half },
        { x: 0, y: half, w: pw, h: H - half },
      ],
    };
  }
  if (layout === "stacked") {
    const half = Math.floor(H / 2);
    return {
      views: [
        { x: 0, y: 0, w: W, h: half - P },
        { x: 0, y: half, w: W, h: H - half - P },
      ],
      panels: [
        { x: 0, y: half - P, w: W, h: P },
        { x: 0, y: H - P, w: W, h: P },
      ],
    };
  }
  const half = Math.floor(W / 2);
  const panels = [
    { x: 0, y: H - P, w: half, h: P },
    { x: half, y: H - P, w: W - half, h: P },
  ];
  if (layout === "ghost") return { views: [{ x: 0, y: 0, w: W, h: H - P }], panels };
  return {
    views: [
      { x: 0, y: 0, w: half, h: H - P },
      { x: half, y: 0, w: W - half, h: H - P },
    ],
    panels,
  };
}

/** A rectangle scaled (an export renders at the frame size times supersampling). */
export function scaleRect(r: Rect, k: number): Rect {
  const x = Math.round(r.x * k);
  const y = Math.round(r.y * k);
  return { x, y, w: Math.round((r.x + r.w) * k) - x, h: Math.round((r.y + r.h) * k) - y };
}
