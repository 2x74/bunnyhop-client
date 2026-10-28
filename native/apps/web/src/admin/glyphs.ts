// The admin's icon set. Same construction as the game's settings icons (src/ui/icons.ts, after Aimperion's settings
// glyphs): a 20-unit grid, stroke only in currentColor, square caps and mitred joins, one stroke weight. Drawn here
// rather than taken from a stock pack (Lucide reads as the generated default), and kept here so the admin bundle stays
// free of game UI code. Unknown names fall back to `dot` (a tab added later still gets a mark).
//
// Groups: sections (one per rail tab, keyed by tab id), actions (the verbs on buttons), states (toasts, empty states),
// and arrows. A dot is a zero-length square-capped stroke ("M5 10h0"), which draws a 1.7-unit square.

const NS = "http://www.w3.org/2000/svg";
type Shape = ["p", string] | ["c", number, number, number];
const p = (d: string): Shape => ["p", d];
const c = (cx: number, cy: number, r: number): Shape => ["c", cx, cy, r];

const SHIELD = "M10 2.5L16.5 5V10C16.5 13.6 13.7 16.3 10 17.5C6.3 16.3 3.5 13.6 3.5 10V5Z";

const DRAW: Record<string, Shape[]> = {
  // sections
  queue: [p("M3 4.5H17M3 9H17M3 13.5H9.5"), p("M12 15L14.2 17.2L18 13.4")],
  maps: [p("M3 5L7.5 3L12.5 5L17 3V15L12.5 17L7.5 15L3 17Z"), p("M7.5 3V15M12.5 5V17")],
  overview: [p("M3 3H9V9H3Z"), p("M11 3H17V7H11Z"), p("M11 9H17V17H11Z"), p("M3 11H9V17H3Z")],
  chat: [p("M3 4H17V13H9.5L5.5 16.5V13H3Z")],
  lobbies: [p("M4 8.5H16V16.5H4Z"), p("M7 8.5V6A3 3 0 0 1 13 6V8.5"), p("M10 11.5V13.5")],
  players: [c(10, 6.6, 3.1), p("M3.9 17.2C4.9 14.2 7.3 12.5 10 12.5S15.1 14.2 16.1 17.2")],
  rooms: [p("M3 3.5H17V9H3Z"), p("M3 11H17V16.5H3Z"), p("M6 6.25H7.5M6 13.75H7.5")],
  names: [p("M3 3H10L17 10L10 17L3 10Z"), c(7, 7, 1.2)],
  runs: [c(10, 11, 6), p("M10 11V7.5M8 2.5H12M15 5.5L16.25 4.25")],
  suspicious: [p("M2 10C4 6.2 6.8 4.5 10 4.5S16 6.2 18 10C16 13.8 13.2 15.5 10 15.5S4 13.8 2 10Z"), c(10, 10, 2.2)],
  handbook: [p("M10 5.5C8.2 4 5.8 3.5 3 3.5V15C5.8 15 8.2 15.5 10 17C11.8 15.5 14.2 15 17 15V3.5C14.2 3.5 11.8 4 10 5.5Z"), p("M10 5.5V17")],
  records: [p("M6 3H14V8A4 4 0 0 1 6 8Z"), p("M6 4.5H3V6A3 3 0 0 0 6 9M14 4.5H17V6A3 3 0 0 1 14 9"), p("M10 12V15.5M6.5 17H13.5")],
  feedback: [p("M2.5 11L5 4H15L17.5 11V16H2.5Z"), p("M2.5 11H7L8 13H12L13 11H17.5")],
  announce: [p("M3 8H6.5L14.5 4V16L6.5 12H3Z"), p("M6.5 12L8 17")],
  // A crystal point (the Supporter achievement's mark, in line).
  supporters: [p("M10 1.8 14.4 6.2 13.8 14.6 10 18.2 6.2 14.6 5.6 6.2Z"), p("M5.6 6.2 8.6 7.4H11.4L14.4 6.2M8.6 7.4 8.8 15.6 10 18.2M11.4 7.4 11.2 15.6 10 18.2")],
  admins: [p(SHIELD)],
  staff: [p(SHIELD)],
  log: [p("M7.5 5H17M7.5 10H17M7.5 15H17"), p("M3 5H4.5M3 10H4.5M3 15H4.5")],
  network: [c(10, 4.5, 2), c(4.5, 15, 2), c(15.5, 15, 2), p("M9 6.3L5.5 13.2M11 6.3L14.5 13.2M6.5 15H13.5")],
  // actions
  search: [c(8.5, 8.5, 5.5), p("M12.5 12.5L17 17")],
  message: [p("M3 4.5H17V15.5H3Z"), p("M3 4.5L10 10.5L17 4.5")],
  reply: [p("M8 4.5L3 9.5L8 14.5"), p("M3 9.5H11.5C14.5 9.5 17 11.8 17 15.5")],
  rename: [p("M4 16L4.6 12.8L12.8 4.6L15.4 7.2L7.2 15.4Z"), p("M11 6.4L13.6 9")],
  ban: [c(10, 10, 7), p("M5 5L15 15")],
  mute: [p("M3 7.5H6L10 4V16L6 12.5H3Z"), p("M13 7.5L17 11.5M17 7.5L13 11.5")],
  kick: [p("M8.5 3.5H3.5V16.5H8.5"), p("M8 10H17M13.5 6.5L17 10L13.5 13.5")],
  copy: [p("M7 7H16.5V16.5H7Z"), p("M4 13V3.5H13")],
  refresh: [p("M16.5 10A6.5 6.5 0 1 1 14.3 5.1"), p("M14.5 2V5.5H11")],
  filter: [p("M3 4H17L11.5 10.5V16.5L8.5 15V10.5Z")],
  clock: [c(10, 10, 7), p("M10 6V10L12.8 12")],
  flag: [p("M5 17.5V3"), p("M5 4H15.5L13.5 7.5L15.5 11H5")],
  play: [p("M6.5 4L15.5 10L6.5 16Z")],
  map: [p("M3 5L7.5 3L12.5 5L17 3V15L12.5 17L7.5 15L3 17Z"), p("M7.5 3V15M12.5 5V17")],
  plus: [p("M10 4V16M4 10H16")],
  undo: [p("M6.5 3.5L3 7L6.5 10.5"), p("M3 7H12C14.8 7 17 9.2 17 12S14.8 17 12 17H7")],
  verified: [p("M10 2.5L12 4.3L14.7 4.1L15.3 6.7L17.5 8.3L16.4 10.8L17.5 13.3L15.3 14.9L14.7 17.5L12 17.3L10 19L8 17.3L5.3 17.5L4.7 14.9L2.5 13.3L3.6 10.8L2.5 8.3L4.7 6.7L5.3 4.1L8 4.3Z"), p("M6.8 10.8L9 13L13.4 8.6")],
  activity: [p("M2 10.5H5.5L8 4.5L12 15.5L14.5 10.5H18")],
  keyboard: [p("M2.5 5H17.5V15H2.5Z"), p("M5.5 8H5.5M8.5 8H8.5M11.5 8H11.5M14.5 8H14.5M6.5 12H13.5")],
  more: [p("M4.5 10H4.5M10 10H10M15.5 10H15.5")],
  paste: [p("M6 4H4.5V17H15.5V4H14"), p("M7 2.8H13V5.5H7Z"), p("M7.5 9.5H12.5M7.5 13H11")],
  note: [p("M4 3H16V17H4Z"), p("M7 7H13M7 10.5H13M7 14H10.5")],
  shield: [p(SHIELD)],
  // states
  check: [p("M4 10.5L8 14.5L16 5.5")],
  alert: [p("M10 2.5L18 16.5H2Z"), p("M10 8V11.5M10 14V14")],
  info: [c(10, 10, 7.5), p("M10 9V14M10 6V6")],
  empty: [p("M3 10H7L8.5 12.5H11.5L13 10H17"), p("M3 10L5.5 4.5H14.5L17 10V15.5H3Z")],
  // arrows
  chevron: [p("M7.5 4.5L13 10L7.5 15.5")],
  down: [p("M4.5 7.5L10 13L15.5 7.5")],
  back: [p("M12.5 4.5L7 10L12.5 15.5")],
  arrow: [p("M3.5 10H16M11 5L16 10L11 15")],
  ext: [p("M8 4.5H15.5V12"), p("M15.5 4.5L5 15")],
  close: [p("M5 5L15 15M15 5L5 15")],
  out: [p("M8 4H4V16H16V12"), p("M11 3H17V9M17 3L9.5 10.5")],
  up: [p("M10 16V4.5M5 9.5L10 4.5L15 9.5")],
  dot: [p("M8.5 8.5H11.5V11.5H8.5Z")],
  // the case boards: three columns of cards; a pin; a warning (a triangle with its mark)
  board: [p("M3 3.5H7V16.5H3Z"), p("M8.5 3.5H12.5V11H8.5Z"), p("M14 3.5H18V13.5H14Z")],
  pin: [p("M7 3H13L12 8.5L15 11.5H5L8 8.5Z"), p("M10 11.5V17.5")],
  warn: [p("M10 3L18 16.5H2Z"), p("M10 8V11.5M10 14V14")],
  assign: [c(8, 6.6, 3.1), p("M2.5 17C3.4 14.2 5.6 12.5 8 12.5C9.4 12.5 10.7 13 11.7 14"), p("M15.5 11V17M12.5 14H18.5")],
};

/** Whether a glyph of that name exists (callers fall back to text). */
export const hasGlyph = (name: string): boolean => name in DRAW;

/** One glyph (a fresh node each call), decorative: aria-hidden. */
export function glyph(name: string, size = "1em"): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  const attrs: Record<string, string> = {
    class: `glyph g-${name}`,
    viewBox: "0 0 20 20",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "square",
    "stroke-linejoin": "miter",
    "aria-hidden": "true",
    focusable: "false",
  };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  for (const sh of DRAW[name] ?? DRAW.dot) {
    const n = document.createElementNS(NS, sh[0] === "p" ? "path" : "circle");
    if (sh[0] === "p") n.setAttribute("d", sh[1]);
    else (n.setAttribute("cx", String(sh[1])), n.setAttribute("cy", String(sh[2])), n.setAttribute("r", String(sh[3])));
    s.append(n);
  }
  return s;
}
