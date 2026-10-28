// Strafe guide: two thin arcs either side of the crosshair, one per strafe key. The arc of the key you hold lights
// up; it turns green while the mouse turns the same way (in sync, gaining speed) and red while it turns the other
// way. If you hold a key without turning, a small chevron on that side says which way to move the mouse. Optional
// "details" (G cycles it, off by default): sync and speed gained per hop. Reads StrafeMeter; never the sim.

import { h } from "../ui/dom";
import type { StrafeMeter } from "./goals";

const SVGNS = "http://www.w3.org/2000/svg";
const svg = (tag: string, attrs: Record<string, string | number>) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

const R = 40;
const SPAN = 28; // degrees either side of horizontal

/** Arc of radius R centred on `deg` (0 = right, 180 = left). */
function arc(deg: number): string {
  const p = (a: number) => `${(Math.cos((a * Math.PI) / 180) * R).toFixed(2)} ${(-Math.sin((a * Math.PI) / 180) * R).toFixed(2)}`;
  return `M${p(deg - SPAN)} A${R} ${R} 0 0 0 ${p(deg + SPAN)}`;
}

export type GuideMode = "on" | "details" | "off";

export class StrafeGuide {
  readonly el: HTMLElement;
  private left: SVGElement;
  private right: SVGElement;
  private chevL: SVGElement;
  private chevR: SVGElement;
  private details: HTMLElement;
  private lastPaint = 0;
  private state = "";

  constructor() {
    const s = svg("svg", { viewBox: "-60 -60 120 120", class: "tg-arcs", "aria-hidden": "true" });
    this.left = svg("path", { d: arc(180), class: "tg-arc" });
    this.right = svg("path", { d: arc(0), class: "tg-arc" });
    this.chevL = svg("path", { d: "M-47 -6 L-53 0 L-47 6", class: "tg-chev l" });
    this.chevR = svg("path", { d: "M47 -6 L53 0 L47 6", class: "tg-chev r" });
    s.append(this.left, this.right, this.chevL, this.chevR);
    this.details = h("div.tg-details", { hidden: true });
    this.el = h("div.tut-guide", { "aria-hidden": "true" }, s, this.details);
  }

  set mode(m: GuideMode) {
    this.el.hidden = m === "off";
    this.details.hidden = m !== "details";
  }

  /** Repaints at most ~30 times a second. */
  update(m: StrafeMeter, now: number): void {
    if (now - this.lastPaint < 33) return;
    this.lastPaint = now;
    const air = m.airborne;
    const turning = Math.abs(m.turnRate) > 25 ? Math.sign(m.turnRate) : 0; // + = left
    const keySide = m.key < 0 ? 1 : m.key > 0 ? -1 : 0; // + = left
    const synced = air && keySide !== 0 && turning === keySide;
    const wrong = air && keySide !== 0 && turning !== 0 && !synced;
    const still = air && keySide !== 0 && turning === 0;
    const side = (on: boolean) => (!on ? "" : !air ? "on ground" : synced ? "on good" : wrong ? "on bad" : "on");
    const l = side(keySide > 0);
    const r = side(keySide < 0);
    const key = `${l}|${r}|${still}|${keySide}`;
    if (key !== this.state) {
      this.state = key;
      this.left.setAttribute("class", `tg-arc ${l}`);
      this.right.setAttribute("class", `tg-arc ${r}`);
      this.chevL.classList.toggle("show", still && keySide > 0);
      this.chevR.classList.toggle("show", still && keySide < 0);
    }
    if (!this.details.hidden) {
      const hop = m.hopGain === null ? "–" : `${m.hopGain >= 0 ? "+" : ""}${Math.round(m.hopGain)}`;
      this.details.textContent = `${Math.round(m.sync)}% sync\n${hop} per hop`;
    }
  }
}
