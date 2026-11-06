// CS:S `cl_showpos` (Settings → HUD → Position, the console's cl_showpos): the position readout in the top-right corner,
// as Source's client draws it (game/client/vgui_fpspanel.cpp CFPSPanel, the 2013 CS:S branch):
//
//   pos:  %.02f %.02f %.02f     cl_showpos 1: the eye (MainViewOrigin); 2: the feet (GetAbsOrigin)
//   ang:  %.02f %.02f %.02f     1: the view angles, pitch yaw roll (MainViewAngles); 2: the body's (yaw only)
//   vel:  %.2f                  the 3D speed (GetLocalVelocity().Length())
//
// Exactly CS:S's three lines (no `name:` line: that's CS:GO's). White monospace with a dark outline, in a 300 px panel
// flush with the top-right corner, text 2 px in. Display only: it reads the state, never input or replays.
// One ShowPos per view (the game HUD, the replay viewer); update() is called each frame and touches the DOM only when a
// printed value changes.

import { h } from "../ui/dom";
import "./showpos.css";

/** One frame's state, in Source units and degrees (yaw CCW from +X, pitch + down). */
export interface ShowPosState {
  /** Feet origin. */
  pos: ArrayLike<number>;
  /** Eye height above the feet (Source's view offset). */
  viewZ: number;
  vel: ArrayLike<number>;
  pitch: number;
  yaw: number;
}

/** Source prints angles from -180 to 180 (AngleNormalize). */
export const normalize180 = (a: number): number => {
  const r = ((((a + 180) % 360) + 360) % 360) - 180;
  return r === -180 ? 180 : r;
};

/** printf("%.02f"): two decimals, "-0.00" for a small negative as C prints it. */
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "0.00");

/** The lines cl_showpos `mode` (1 or 2) prints for `s`. */
export function showPosLines(s: ShowPosState, mode: number): string[] {
  const eye = mode !== 2;
  const z = s.pos[2] + (eye ? s.viewZ : 0);
  const pitch = eye ? s.pitch : 0;
  const speed = Math.hypot(s.vel[0], s.vel[1], s.vel[2]);
  return [
    `pos:  ${f2(s.pos[0])} ${f2(s.pos[1])} ${f2(z)}`,
    `ang:  ${f2(normalize180(pitch))} ${f2(normalize180(s.yaw))} ${f2(0)}`,
    `vel:  ${f2(speed)}`,
  ];
}

export class ShowPos {
  readonly el: HTMLElement;
  private lines: Text[];
  private shown = false;

  constructor(extraClass = "") {
    this.lines = [0, 1, 2].map(() => document.createTextNode(""));
    this.el = h(`div.showpos${extraClass ? "." + extraClass : ""}`, { "aria-hidden": "true", hidden: true }, ...this.lines.map((t) => h("div", null, t)));
  }

  /** Each frame: `mode` 0 hides it (cl_showpos 0). */
  update(mode: number, s: ShowPosState | null): void {
    const on = mode > 0 && !!s;
    if (on !== this.shown) {
      this.shown = on;
      this.el.hidden = !on;
    }
    if (!on) return;
    const next = showPosLines(s!, mode);
    for (let i = 0; i < next.length; i++) if (this.lines[i].data !== next[i]) this.lines[i].data = next[i];
  }
}
