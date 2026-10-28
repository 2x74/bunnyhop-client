// "Show on screen": the pieces of the screen players switch on and off most, as a picture of the screen used in two
// places: the top of Settings → HUD and the pause menu's On screen tab. Each switch writes the same pref as its full settings
// row (the HUD element's `on`, ghost.tag, viewmodel.show...), so the two places can't disagree (after Aimperion's pause
// card, whose quick rows write the same config keys as the settings page and the hotkey).
//
// The keys overlay comes first and on its own row: it's the one people most want gone (or back) in one click. It also
// has a bind, unbound by default (Settings → Keys → Show / hide keys overlay), like Aimperion's metronome key.

import { prefs, keyLabel, type HiddenKeeps, type Prefs } from "./settings";
import { row, segmented, toggle } from "./controls";
import { h } from "./dom";
import { placeStyle, type HudElId } from "../hud/layout";
import "./quick-toggles.css";

const P = () => prefs.get();
const up = (fn: (p: Prefs) => void) => prefs.update(fn);

interface Quick {
  label: string;
  get: () => boolean;
  set: (v: boolean) => void;
  desc: string;
  keywords: string;
  /**
   * The setting's own row lives in another section (this switch is a shortcut to it). Such rows are left out of the
   * settings search, which finds the row in its own section instead.
   */
  mirror?: boolean;
}

const element = (id: HudElId, label: string, desc: string, keywords: string): Quick => ({
  label,
  get: () => P().hud.layout[id].on,
  set: (v) => up((p) => (p.hud.layout[id].on = v)),
  desc,
  keywords: `hud element show hide ${keywords}`,
});

const QUICK: Quick[] = [
  element("speed", "Speed", "Horizontal speed, u/s.", "speedometer velocity ups units"),
  element("timer", "Timer", "Run time.", "clock time"),
  element("split", "Split vs PB", "Live +/- against your PB ghost.", "splits delta compare"),
  element("stats", "Jumps · strafes · sync", "Jumps, strafes and sync of the current run.", "stats sync strafes jumps"),
  element("strafeTrainer", "Strafe trainer", "Mouse turn pace for manual A/D styles. Aim for 100%; !st toggles it. Move and resize in Edit layout.", "strafetrainer training coach turn pace gain"),
  element("sync", "Sync bar", "Strafe sync of the current jump.", "strafe sync meter"),
  element("fps", "FPS counter", "Frames per second.", "frames framerate"),
  element("chat", "Chat", "Multiplayer chat (rooms only).", "messages multiplayer"),
  {
    label: "Name tags",
    get: () => P().ghost.tag || P().tags.players,
    set: (v) => up((p) => ((p.ghost.tag = v), (p.tags.players = v))),
    desc: "Names above other players (rooms) and ghosts. Ghost → Name tags switches them separately.",
    keywords: "name names tag tags nametag nametags label labels players",
    mirror: true,
  },
  {
    label: "Ghosts",
    get: () => P().showGhost,
    set: (v) => up((p) => (p.showGhost = v)),
    desc: "Race ghosts (your PB, the world record, a replay you loaded). Ghost has which ones and how they look.",
    keywords: "ghost ghosts race replay",
    mirror: true,
  },
  {
    label: "Viewmodel",
    get: () => P().viewmodel.show,
    set: (v) => up((p) => (p.viewmodel.show = v)),
    desc: "Your first-person hands and the carrot blade. More in Viewmodel.",
    keywords: "viewmodel hands carrot knife weapon r_drawviewmodel",
    mirror: true,
  },
];

const bindOf = (a: "keysOverlay" | "hideUi") => {
  const c = P().binds[a]?.[0];
  return c ? keyLabel(c) : null;
};

/** The keys overlay's one-click switch (Settings → HUD and the pause menu). */
export function keysOverlaySwitch(): HTMLElement {
  return toggle("Keys overlay", () => P().hud.layout.keys.on, (v) => up((p) => (p.hud.layout.keys.on = v)), {
    hint: bindOf("keysOverlay") ? `${bindOf("keysOverlay")} in game` : undefined,
    desc: () =>
      `The keys you press, on screen (replays and ghosts too). ${bindOf("keysOverlay") ? `${bindOf("keysOverlay")} shows / hides it in game.` : "Bind a key to show / hide it in game: Keys → Show / hide keys overlay."} Its look is under Keys overlay.`,
    keywords: "keys overlay key display input display inputs wasd keyboard overlay show hide keystrokes",
  });
}

/** Hide UI in game (ui/hide-ui.ts; Settings → HUD and the pause menu). The same pref its key flips. */
export function hideUiSwitch(): HTMLElement {
  return toggle("Hide UI", () => P().hud.hidden, (v) => up((p) => (p.hud.hidden = v)), {
    hint: bindOf("hideUi") ? `${bindOf("hideUi")} in game and replays` : undefined,
    desc: "Just the game, for recording clips. Esc still opens the pause menu.",
    keywords: "hide ui hud interface clean clip record recording video screenshot cinematic cl_drawhud f1",
  });
}

/** What a hidden UI keeps, in game and in replays (Settings → HUD). */
export function hideUiKeeps(): HTMLElement {
  return segmented<HiddenKeeps>("Hidden UI keeps", () => P().hud.hiddenKeeps, (v) => up((p) => (p.hud.hiddenKeeps = v)), [
    ["speedKeys", "Speed and keys"],
    ["nothing", "Nothing"],
  ], { keywords: "hide ui hud speed keys overlay speedometer clip record keep" });
}

// ---------------------------------------------------------------------------------------------
// The picture: a miniature of the game frame (hud/layout.ts placeStyle, the same numbers the F2 editor uses) with each
// piece where it really sits. Lit = on, dim = off; click one to switch it; hover (or focus) names it in the line under
// the frame. Twelve buttons, painted on a click; nothing runs otherwise.

/** What a piece looks like in miniature: its box (in % of the frame's width / height at scale 1) and a tiny stand-in. */
interface Piece {
  q: Quick;
  /** HUD element (placed by the layout); else a fixed spot in the world (ghost, name tags, viewmodel). */
  el?: HudElId;
  at?: { left: number; top: number };
  w: number;
  h: number;
  body: () => (Node | string)[];
}

const span = (cls: string, text = "") => h(`span.${cls}`, null, text);
const BUNNY_SVG = `<svg viewBox="0 0 20 40" aria-hidden="true"><path d="M6 1c1.6 0 2 3 2 7l.2 3h3.6l.2-3c0-4 .4-7 2-7s1.6 4.5.8 9l-.6 3.2A7 7 0 0 1 17 19v9a3 3 0 0 1-2 2.8V39h-3.5v-7h-3V39H5v-8.2A3 3 0 0 1 3 28v-9a7 7 0 0 1 2.8-5.8L5.2 10C4.4 5.5 4.4 1 6 1z" fill="currentColor"/></svg>`;
const CARROT_SVG = `<svg viewBox="0 0 40 60" aria-hidden="true"><path d="M27 2 33 30 25 31z" fill="currentColor"/><path d="M22 31h13l-1 5H23z" fill="currentColor" opacity=".7"/><path d="M8 44c6-6 16-9 26-8l2 12c-8 3-18 6-28 12z" fill="currentColor" opacity=".55"/></svg>`;

function pieces(): Piece[] {
  const by = (label: string) => QUICK.find((q) => q.label === label)!;
  const keysQ: Quick = { label: "Keys overlay", get: () => P().hud.layout.keys.on, set: (v) => up((p) => (p.hud.layout.keys.on = v)), desc: "", keywords: "" };
  return [
    { q: by("Speed"), el: "speed", w: 6, h: 6, body: () => [span("mn-big", "286")] },
    { q: by("Timer"), el: "timer", w: 8, h: 3.4, body: () => [span("mn-txt", "0:12.48")] },
    { q: by("Split vs PB"), el: "split", w: 4.6, h: 3, body: () => [span("mn-txt.gain", "-0.21")] },
    { q: by("Jumps · strafes · sync"), el: "stats", w: 11, h: 2.8, body: () => [span("mn-txt.dim", "12   38   91%")] },
    { q: by("Sync bar"), el: "sync", w: 11, h: 1.6, body: () => [span("mn-bar")] },
    { q: keysQ, el: "keys", w: 8, h: 10, body: () => [span("mn-keys", ""), span("mn-keys", ""), span("mn-keys", "")] },
    { q: by("Strafe trainer"), el: "strafeTrainer", w: 12, h: 2.6, body: () => [span("mn-gauge")] },
    { q: by("FPS counter"), el: "fps", w: 4, h: 2.6, body: () => [span("mn-txt.dim", "240")] },
    { q: by("Chat"), el: "chat", w: 19, h: 12, body: () => [span("mn-line"), span("mn-line.short"), span("mn-line")] },
    { q: by("Ghosts"), at: { left: 30, top: 50 }, w: 3.4, h: 13, body: () => [h("span.mn-bunny", { html: BUNNY_SVG })] },
    { q: by("Name tags"), at: { left: 30, top: 38 }, w: 9, h: 3.2, body: () => [span("mn-tag")] },
    { q: by("Viewmodel"), at: { left: 84, top: 78 }, w: 13, h: 34, body: () => [h("span.mn-carrot", { html: CARROT_SVG })] },
  ];
}

/**
 * "Show on screen" as a picture of the screen (Settings → HUD and the pause menu's On screen tab). It's one settings row
 * (so the search finds it by any piece's name) and stays in step with the same prefs' switches elsewhere.
 */
export function hudMiniature(): HTMLElement {
  const aspect = Math.max(1.2, Math.min(2.4, innerWidth / Math.max(1, innerHeight)));
  const frame = h("div.mn-frame", { style: `aspect-ratio:${aspect.toFixed(3)};--ar:${aspect.toFixed(3)}`, role: "group", "aria-label": "Show on screen" }, h("span.mn-xhair", { "aria-hidden": "true" }));
  const say = h("p.mn-say", { "aria-hidden": "true" });
  const idle = "Click a piece to show or hide it.";
  say.textContent = idle;
  const list = pieces();
  const btns: [Piece, HTMLButtonElement][] = [];
  const paint = () => {
    const lay = P().hud.layout;
    for (const [pc, b] of btns) {
      const on = pc.q.get();
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      if (pc.el) {
        const place = placeStyle(lay[pc.el]);
        Object.assign(b.style, place);
        b.style.setProperty("--s", String(lay[pc.el].s));
      }
    }
  };
  for (const pc of list) {
    const b = h(
      `button.mn-el.mn-el-${pc.el ?? pc.q.label.toLowerCase().replace(/\W+/g, "-")}`,
      {
        type: "button",
        "aria-label": pc.q.label,
        style: `--w:${pc.w};--h:${pc.h}${pc.at ? `;left:${pc.at.left}%;top:${pc.at.top}%;translate:-50% -50%` : ""}`,
        onclick: () => {
          pc.q.set(!pc.q.get());
          paint();
          name(pc);
          // Other switches for the same prefs (Ghosts, Name tags, Viewmodel in their own sections) follow.
          b.dispatchEvent(new Event("change", { bubbles: true }));
        },
      },
      ...pc.body(),
    ) as HTMLButtonElement;
    const name = (x: Piece) => (say.textContent = `${x.q.label}: ${x.q.get() ? "on" : "off"}`);
    b.addEventListener("pointerenter", () => name(pc));
    b.addEventListener("focus", () => name(pc));
    b.addEventListener("pointerleave", () => (say.textContent = idle));
    b.addEventListener("blur", () => (say.textContent = idle));
    btns.push([pc, b]);
    frame.append(b);
  }
  paint();
  const r = row("Show on screen", h("div.mn", null, frame, say), {
    keywords: `hud show hide on screen ${list.map((x) => `${x.q.label} ${x.q.keywords}`).join(" ")}`,
  });
  r.classList.add("mn-row", "is-syncable");
  (r as HTMLElement & { sync?: () => void }).sync = paint;
  return r;
}

/** The pieces players switch most, as the picture (the pause menu's On screen tab and Settings → HUD). */
export const quickGrid = hudMiniature;
