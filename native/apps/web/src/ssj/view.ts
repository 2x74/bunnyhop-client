// The Jump stats HUD element (layout id "jumpStats"): the last reported jump, in two lines like the chat line
// ("Jump 6 · 1013 u/s (+87)" / "Gain 87.5% · Sync 92% · 5 strafes"). Shared by the game HUD (hud.ts) and the replay
// viewer's HUD (viewer/hud.ts). It changes only when a new report comes in: no fade, no flash.

import { h } from "../ui/dom";
import { SSJ_SEP, ssjItems, type SsjFields, type SsjItem, type SsjReport } from "./stats";
import "./ssj.css";

/** Sample report for the layout editor and the settings. */
export const SSJ_DEMO: SsjReport = { jump: 6, speed: 1013, diff: 87, height: 0, gain: 87.52, sync: 92.4, eff: 78.1, strafes: 9, time: 12.34 };

/** Items as nodes: numbers bold (`.ssj-good` on a gain worth the accent). */
export function ssjNodes(items: SsjItem[], bold: boolean): (string | Node)[] {
  const out: (string | Node)[] = [];
  items.forEach((it, i) => {
    if (i) out.push(SSJ_SEP);
    for (const t of it) {
      if (typeof t === "string") out.push(t);
      else if (t.good) out.push(h(bold ? "b.ssj-good" : "span.ssj-good", null, t.n));
      else out.push(bold ? h("b", null, t.n) : t.n);
    }
  });
  return out;
}

export class SsjView {
  readonly el = h("div.ssj", { "aria-hidden": "true" });
  private head = h("div.ssj-line");
  private rest = h("div.ssj-line");
  private last = "";

  constructor() {
    this.el.append(this.head, this.rest);
  }

  /** Shows a report (null: nothing yet). Returns whether there is something to show. */
  show(r: SsjReport | null, f: SsjFields): boolean {
    const key = r ? JSON.stringify([r, f]) : "";
    if (key === this.last) return !!r;
    this.last = key;
    if (!r) {
      this.head.replaceChildren();
      this.rest.replaceChildren();
      return false;
    }
    const items = ssjItems(r, f);
    // Line 1: jump and speed; line 2: everything else.
    const split = f.speed || (f.diff && r.diff !== null) ? 2 : 1;
    this.head.replaceChildren(...ssjNodes(items.slice(0, split), true));
    this.rest.replaceChildren(...ssjNodes(items.slice(split), true));
    this.rest.hidden = items.length <= split;
    return true;
  }
}
