// Hold-to-restart ring around the crosshair (restart-guard.ts): fills while a restart key is held, and a brief
// "Hold R to restart" whisper (notify/) above the crosshair after a quick tap. Styles: hud/restart-ring.css.

import { h } from "../ui/dom";
import "./restart-ring.css";
import { whisper } from "../notify";

const R = 15;
const C = 2 * Math.PI * R;
const NS = "http://www.w3.org/2000/svg";

export class RestartRing {
  readonly el: HTMLElement;
  private arc: SVGCircleElement;

  constructor(parent: HTMLElement) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 40 40");
    svg.setAttribute("aria-hidden", "true");
    const circle = (cls: string) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", "20");
      c.setAttribute("cy", "20");
      c.setAttribute("r", String(R));
      c.setAttribute("class", cls);
      svg.append(c);
      return c;
    };
    circle("rr-track");
    this.arc = circle("rr-fill");
    this.arc.style.strokeDasharray = `${C}`;
    this.arc.style.strokeDashoffset = `${C}`;
    this.el = h("div#restart-ring.hide", { "aria-hidden": "true" }, h("div.rr-dial", null, svg));
    parent.append(this.el);
  }

  /** Holding: ring at `progress` (0..1). */
  show(progress: number): void {
    this.el.classList.remove("hide");
    this.el.classList.add("holding");
    this.arc.style.strokeDashoffset = `${C * (1 - progress)}`;
  }

  /** The hint for a moment (a tap released before the hold completed): a whisper just above the crosshair. */
  flash(text: string, ms = 1400): void {
    this.hide();
    whisper(text, { at: this.el, gap: 34, ms, key: "restart-hint" });
  }

  hide(): void {
    this.el.classList.add("hide");
    this.el.classList.remove("holding");
    this.arc.style.strokeDashoffset = `${C}`;
  }
}
