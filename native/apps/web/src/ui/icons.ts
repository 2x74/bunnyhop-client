// Inline SVG icons for the settings screen (and anything else that wants them): one consistent set on a 20-unit grid,
// stroke-only in currentColor, square caps and mitred joins (the same construction as Aimperion's settings glyphs), so
// they stay crisp at the 14–18 px they render at and recolour with the text around them. No icon font, no sprite, no
// external file: every call builds a fresh node (a shared node would be MOVED by a second append, not copied).
//
//   btn.append(icon("reset"), "Reset");          // decorative (aria-hidden), beside its word
//   btn.append(icon("close", { title: "Close" })); // the icon IS the label: role="img" + <title>
//
// Section glyphs are keyed by the settings section id (sectionIcon); a registered section can name any icon here with
// `icon` in its options (settings-registry.ts).

const NS = "http://www.w3.org/2000/svg";

type Shape = ["p", string] | ["c", number, number, number];

const p = (d: string): Shape => ["p", d];
const c = (cx: number, cy: number, r: number): Shape => ["c", cx, cy, r];

/** The set. Silhouettes first: each has to read at 14 px. */
const DRAW = {
  // ---- settings sections
  /** A mouse: body with the wheel. */
  mouse: [p("M10 2.5C7.6 2.5 6 4.1 6 6.5V13C6 15.6 7.7 17.5 10 17.5S14 15.6 14 13V6.5C14 4.1 12.4 2.5 10 2.5Z"), p("M10 5.5V8")],
  /** A crosshair: four arms and a dot. */
  crosshair: [p("M10 2V6.5M10 13.5V18M2 10H6.5M13.5 10H18"), p("M9.5 9.5H10.5V10.5H9.5Z")],
  /** The HUD: screen corners with a speed bar. */
  hud: [p("M2.5 6.5V2.5H6.5M13.5 2.5H17.5V6.5M17.5 13.5V17.5H13.5M6.5 17.5H2.5V13.5"), p("M7 12.5H13M8.5 8.5H11.5")],
  /** A keyboard. */
  keys: [p("M2 5H18V15H2Z"), p("M5 8.5H6M9.5 8.5H10.5M14 8.5H15M6.5 11.5H13.5")],
  /** A ghost: domed head, wavy hem, two eyes. */
  ghost: [p("M4.5 17.5V9A5.5 5.5 0 0 1 15.5 9V17.5L13.6 15.8L11.8 17.5L10 15.8L8.2 17.5L6.4 15.8Z"), p("M8 8.5V10M12 8.5V10")],
  /** A monitor on its stand. */
  graphics: [p("M2.5 3.5H17.5V13.5H2.5Z"), p("M10 13.5V17M6.5 17H13.5")],
  /** The carrot blade: body, leaves, two ridges. */
  viewmodel: [p("M3 17L7.6 7.9L12.1 12.4Z"), p("M9.85 10.15L15.5 4.5M12.7 7.3L12.7 2.5M12.7 7.3L17.5 7.3"), p("M5.6 13.4L6.9 14.7M7 10.6L8.3 11.9")],
  /** A paint brush: handle, ferrule, bristle tip. */
  paint: [p("M16.5 3.5L9.5 10.5"), p("M9.5 10.5L11 12L8.5 14.5L7 13Z"), p("M7 13L3.5 16.5L4.5 17.5L8.5 14.5")],
  /** A ruler: a bar with tick marks. */
  measure: [p("M2.5 7H17.5V13H2.5Z"), p("M5.5 7V9.5M8.5 7V10.5M11.5 7V9.5M14.5 7V10.5")],
  /** A speaker with two waves. */
  audio: [p("M3 7.5H6L10 4V16L6 12.5H3Z"), p("M13 7.5A3.5 3.5 0 0 1 13 12.5M15.3 5A7 7 0 0 1 15.3 15")],
  /** A person: head over shoulders. */
  account: [c(10, 6.6, 3.1), p("M3.9 17.2C4.9 14.2 7.3 12.5 10 12.5S15.1 14.2 16.1 17.2")],
  /** Two sliders: any other settings section. */
  tune: [p("M2.5 6H7M11 6H17.5M2.5 14H11M15 14H17.5"), c(9, 6, 2), c(13, 14, 2)],

  // ---- chrome
  search: [c(8.5, 8.5, 5.2), p("M12.4 12.4L17 17")],
  close: [p("M5 5L15 15M15 5L5 15")],
  /** ⓘ: circle, stem and dot (a hairline stub). */
  info: [c(10, 10, 7.25), p("M10 9V14M10 6.25V6.75")],
  /** Counter-clockwise arrow: back to the defaults. */
  reset: [p("M4.2 7.6A6.2 6.2 0 1 1 3.8 10.6"), p("M3.5 3.5V7.75H7.75")],
  /** Arrow out of a tray: export / download. */
  export: [p("M10 12.5V2.5"), p("M6.25 6.25L10 2.5L13.75 6.25"), p("M3 12V17H17V12")],
  /** Arrow into a tray: import / upload. */
  import: [p("M10 2.5V12.5"), p("M6.25 8.75L10 12.5L13.75 8.75"), p("M3 12V17H17V12")],
  copy: [p("M7 7H17V17H7Z"), p("M13 7V3H3V13H7")],
  file: [p("M4.5 2.5H11.5L15.5 6.5V17.5H4.5Z"), p("M11.5 2.5V6.5H15.5")],
  check: [p("M4 10.5L8 14.5L16 5.5")],
  chevronRight: [p("M7.5 4.5L13 10L7.5 15.5")],
  undo: [p("M7.5 4L3.5 8L7.5 12"), p("M3.5 8H12A4.5 4.5 0 0 1 12 17H8")],
  warn: [p("M10 2.5L18 17H2Z"), p("M10 8V12M10 14.25V14.75")],
  /** A die showing five: a random map (the map list's toolbar). */
  die: [p("M5.5 3H14.5A2.5 2.5 0 0 1 17 5.5V14.5A2.5 2.5 0 0 1 14.5 17H5.5A2.5 2.5 0 0 1 3 14.5V5.5A2.5 2.5 0 0 1 5.5 3Z"), p("M7 6.75V7.25M13 6.75V7.25M10 9.75V10.25M7 12.75V13.25M13 12.75V13.25")],
  /** A five-point star: a favorite map (filled with .on in the map list's CSS). */
  star: [p("M10 2.8L11.94 7.93L17.42 8.19L13.14 11.62L14.58 16.91L10 13.9L5.42 16.91L6.86 11.62L2.58 8.19L8.06 7.93Z")],
  /** Arrow out of a doorway, to the left: leave (the pause menu's Main menu). */
  leave: [p("M11 3H16.5V17H11"), p("M13 10H3.5"), p("M7 6.5L3.5 10L7 13.5")],
  /** A bell: notifications (social/dock.ts). */
  bell: [p("M5 14.5V9A5 5 0 0 1 15 9V14.5L16.5 16H3.5Z"), p("M8.2 16.2A1.9 1.9 0 0 0 11.8 16.2")],
  /** Two heads: friends (social/dock.ts). */
  friends: [c(7.5, 7, 2.7), p("M2.5 16.5C3.3 13.8 5.2 12.3 7.5 12.3S11.7 13.8 12.5 16.5"), c(13.6, 6.4, 2.2), p("M13.4 10.9C15.4 10.9 16.9 12.3 17.5 14.6")],
  /** A speech bubble: a message. */
  message: [p("M3 4H17V13.5H8.5L5 16.5V13.5H3Z")],
  /** An eye: spectate (a friend's row, social/dock.ts). */
  eye: [p("M2 10C3.9 6.6 6.7 4.75 10 4.75S16.1 6.6 18 10C16.1 13.4 13.3 15.25 10 15.25S3.9 13.4 2 10Z"), c(10, 10, 2.5)],

  // ---- pause rail, action cards, panel tabs (menu.ts)
  /** A triangle pointing right: play / resume / watch. */
  play: [p("M6 3.5L16 10L6 16.5Z")],
  /** Clockwise arrow: restart / watch again (the mirror of `reset`). */
  restart: [p("M15.8 7.6A6.2 6.2 0 1 0 16.2 10.6"), p("M16.5 3.5V7.75H12.25")],
  /** A house: back to the main track. */
  home: [p("M2.5 9.5L10 3L17.5 9.5"), p("M4.5 8V17H15.5V8"), p("M8 17V12H12V17")],
  /** A globe: meridians and the equator (play online). */
  globe: [c(10, 10, 7.5), p("M2.5 10H17.5"), p("M10 2.5C7.4 5.2 7.4 14.8 10 17.5M10 2.5C12.6 5.2 12.6 14.8 10 17.5")],
  /** Four squares: the map list. */
  grid: [p("M3 3H8.5V8.5H3Z"), p("M11.5 3H17V8.5H11.5Z"), p("M3 11.5H8.5V17H3Z"), p("M11.5 11.5H17V17H11.5Z")],
  /** A four-point sparkle: the tutorial. */
  spark: [p("M10 2.5L11.9 8.1L17.5 10L11.9 11.9L10 17.5L8.1 11.9L2.5 10L8.1 8.1Z")],
  /** A pencil: write feedback. */
  pen: [p("M3 17L3.8 13L13.5 3.3L16.7 6.5L7 16.2Z"), p("M11.5 5.3L14.7 8.5")],
  /** An envelope: the inbox. */
  mail: [p("M2.5 4.5H17.5V15.5H2.5Z"), p("M2.5 4.5L10 11L17.5 4.5")],
  /** Arrow up out of a tray: load a file (same drawing as `export`). */
  upload: [p("M10 12.5V2.5"), p("M6.25 6.25L10 2.5L13.75 6.25"), p("M3 12V17H17V12")],
  /** Arrow down into a tray: save a file (same drawing as `import`). */
  download: [p("M10 2.5V12.5"), p("M6.25 8.75L10 12.5L13.75 8.75"), p("M3 12V17H17V12")],
  /** An arrow leaving a box: share a link. */
  share: [p("M8.5 4H3.5V16.5H16V11.5"), p("M10 10L16.5 3.5"), p("M11.5 3.5H16.5V8.5")],
  /** Two opposed arrows: switch. */
  swap: [p("M3 6.5H17"), p("M13.5 3L17 6.5L13.5 10"), p("M17 13.5H3"), p("M6.5 10L3 13.5L6.5 17")],
  /** A flag on a pole: practice (checkpoints). */
  flag: [p("M5 17.5V2.5"), p("M5 3.5H15L12.5 7L15 10.5H5")],
  /** Two stacked bars with a light each: a server. */
  server: [p("M3 3.5H17V8H3Z"), p("M3 12H17V16.5H3Z"), p("M6 5.75H6.5M6 14.25H6.5")],
  /** Podium bars: the leaderboard. */
  board: [p("M2.5 17H17.5"), p("M3.5 17V11H7V17"), p("M8.25 17V4H11.75V17"), p("M13 17V8H16.5V17")],
  /** A diamond: style. */
  diamond: [p("M10 2.5L17 10L10 17.5L3 10Z")],
  // ---- feedback (feedback/modal.ts)
  /** A camera: add a screenshot. */
  camera: [p("M2.5 6.5H6.5L8 4.5H12L13.5 6.5H17.5V16H2.5Z"), c(10, 11, 2.9)],
  /** A question mark in a circle: help. */
  help: [c(10, 10, 7.25), p("M7.75 8A2.4 2.4 0 1 1 11 10.2C10.4 10.6 10 11 10 12"), p("M10 14.25V14.75")],
  chevronLeft: [p("M12.5 4.5L7 10L12.5 15.5")],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof DRAW;

export const ICON_NAMES = Object.keys(DRAW) as IconName[];

export interface IconOpts {
  /** Rendered size: a CSS length (default "1em", so the icon follows the text it sits in). */
  size?: string;
  /** Only when the icon is the whole label (an icon-only button): makes it role="img" with a <title>. */
  title?: string;
  /** Extra class. */
  cls?: string;
}

/** Builds one icon (a fresh node every call). Unknown names fall back to `tune` rather than throwing in the UI. */
export function icon(name: IconName | string, o: IconOpts = {}): SVGSVGElement {
  const shapes: Shape[] = (DRAW as Record<string, Shape[]>)[name] ?? DRAW.tune;
  const s = document.createElementNS(NS, "svg");
  const size = o.size ?? "1em";
  const attrs: Record<string, string> = {
    class: `icon${o.cls ? ` ${o.cls}` : ""}`,
    viewBox: "0 0 20 20",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "square",
    "stroke-linejoin": "miter",
    focusable: "false",
  };
  for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
  if (o.title) {
    s.setAttribute("role", "img");
    s.setAttribute("aria-label", o.title);
    const t = document.createElementNS(NS, "title");
    t.textContent = o.title;
    s.append(t);
  } else s.setAttribute("aria-hidden", "true");
  for (const sh of shapes) {
    const n = sh[0] === "p" ? document.createElementNS(NS, "path") : document.createElementNS(NS, "circle");
    if (sh[0] === "p") n.setAttribute("d", sh[1]);
    else (n.setAttribute("cx", String(sh[1])), n.setAttribute("cy", String(sh[2])), n.setAttribute("r", String(sh[3])));
    s.append(n);
  }
  return s;
}

/** Section id -> glyph (built-ins and the feature sections registered through settings-registry.ts). */
const SECTION_ICONS: Record<string, IconName> = {
  mouse: "mouse",
  crosshair: "crosshair",
  hud: "hud",
  keys: "keys",
  ghost: "ghost",
  graphics: "graphics",
  viewmodel: "viewmodel",
  audio: "audio",
  account: "account",
  paint: "paint",
  measure: "measure",
};

export function sectionIcon(id: string, named?: string): SVGSVGElement {
  return icon(named ?? SECTION_ICONS[id] ?? "tune");
}
