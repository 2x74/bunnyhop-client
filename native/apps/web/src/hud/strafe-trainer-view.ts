import { h } from "../ui/dom";
import { barBand, barEdge, barFill, GAUGE_BOX, GAUGE_NEEDLE, GAUGE_R, gaugeAngle, gaugeArc, gaugeCue, gaugePace, PACE_MAX, trainerPosition, trainerZone, type TrainerReading, type TrainerCue } from "./strafe-trainer";
import type { TrainerPrefs } from "../ui/settings";
import "./strafe-trainer.css";

const LABELS: Record<TrainerCue, string> = {
  ready: "", keys: "strafe keys", direction: "match your turn",
  slow: "turn more", good: "", fast: "ease turn",
};
const SVG = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}
const HALF = gaugeArc(GAUGE_R, -90, 90);

/** One element for every style (data-style switches the look in CSS); the rail spans 0 to PACE_MAX %. */
export class StrafeTrainerView {
  private number = h("b", null, "—");
  private cue = h("span.st-cue", null, LABELS.ready);
  private marker = h("i.st-marker");
  private fill = h("i.st-fill");
  // The Gauge look's dial (hidden in the others): zone arcs, the centre mark, the needle on its own rotation.
  private arcs = { ok: svg("path", { class: "st-dial-ok" }), good: svg("path", { class: "st-dial-good" }) };
  private needle = svg("g", { class: "st-needle" },
    svg("line", { class: "st-needle-shade", x1: 0, y1: 0, x2: 0, y2: -GAUGE_NEEDLE }),
    svg("line", { x1: 0, y1: 0, x2: 0, y2: -GAUGE_NEEDLE }),
  );
  private dial = svg("svg", { class: "st-dial", viewBox: GAUGE_BOX.join(" "), "aria-hidden": "true" },
    svg("path", { class: "st-dial-shade", d: HALF }), svg("path", { class: "st-dial-bad", d: HALF }), this.arcs.ok, this.arcs.good,
    svg("line", { class: "st-dial-mark", x1: 0, y1: -GAUGE_R + 8, x2: 0, y2: -GAUGE_R - 6 }),
    this.needle, svg("circle", { class: "st-hub", r: 3 }),
  );
  /** Set in place every tick the angle changes: no string, no layout. */
  private turn = this.dial.createSVGTransform();
  readonly el = h("div.st-trainer", { "data-cue": "ready", "data-style": "classic", "aria-label": "Strafe trainer", title: "100% is the target mouse turn per simulation tick. Bar colour: red loses speed, white holds it, orange/green/blue gain more. Works in every style." },
    h("div.st-rail", { "aria-hidden": "true" }, h("span.st-band"), h("i.st-target"), this.marker, this.fill),
    this.dial,
    h("div.st-reading", null, this.number, this.cue),
  );
  constructor() {
    this.needle.transform.baseVal.appendItem(this.turn);
    this.turn.setRotate(-90, 0, 0);
  }
  private p: Pick<TrainerPrefs, "style" | "follow" | "zone" | "dimBelow"> = { style: "classic", follow: false, zone: 10, dimBelow: 0 };
  configure(p: TrainerPrefs): void {
    this.p = p;
    const s = this.el.style;
    s.setProperty("--st-color", p.color);
    s.setProperty("--st-h", String(p.height));
    // Zone half-widths as fractions of the rail (pace PACE_MAX = the whole rail).
    s.setProperty("--st-good", `${(p.zone / PACE_MAX) * 100}%`);
    s.setProperty("--st-ok", `${(Math.min(100, p.zone * 3) / PACE_MAX) * 100}%`);
    this.el.dataset.style = p.style;
    this.el.classList.toggle("st-hints", p.hints);
    this.el.classList.toggle("st-nopace", !p.showPace);
    // Zone half-widths as angles: 100% of pace is a quarter turn.
    const good = (Math.min(100, p.zone) / 100) * 90, ok = (Math.min(100, p.zone * 3) / 100) * 90;
    this.arcs.ok.setAttribute("d", gaugeArc(GAUGE_R, -ok, ok));
    this.arcs.good.setAttribute("d", gaugeArc(GAUGE_R, -good, good));
    this.dirty = true;
  }
  private dirty = true;
  private lastCue: TrainerCue = "ready";
  private lastPace: number | null = null;
  private lastSide = 0;
  private lastShown: number | null = null;
  private lastFill = 0;
  private lastEdge = "";
  private lastBand = "";
  private lastAngle = NaN;
  /**
   * Called every frame, and the Bar's fill changes nearly every tick: each write waits for its own value to change, so
   * the fill alone never touches the text. `lastJump` is the number under the Bar look (the others show the live pace).
   */
  render(r: TrainerReading, lastJump: number | null = null): void {
    const all = this.dirty;
    this.dirty = false;
    const isBar = this.p.style === "bar";
    const isGauge = this.p.style === "gauge";
    const live = isGauge ? gaugePace(r) : r.pace;
    const pace = live === null ? null : Math.round(live);
    const barPace = r.bar ?? r.pace;
    const cue = isBar
      ? r.gain == null || barPace === null ? "ready"
        : Math.abs(barPace - 100) <= 10 ? "good" : barPace < 100 ? "slow" : "fast"
      : isGauge ? gaugeCue(r, this.p.zone) : r.cue;
    const paceChanged = all || pace !== this.lastPace;
    if (all || cue !== this.lastCue) {
      this.lastCue = cue;
      this.el.dataset.cue = cue;
      this.cue.textContent = LABELS[cue];
    }
    if (paceChanged) {
      this.el.dataset.zone = pace === null ? "" : trainerZone(pace, isBar ? 10 : this.p.zone);
      this.el.classList.toggle("st-dim", this.p.dimBelow > 0 && (pace === null || pace < this.p.dimBelow));
    }
    const shown = !isBar ? pace : lastJump === null ? null : Math.round(lastJump);
    if (all || shown !== this.lastShown) {
      this.lastShown = shown;
      this.number.textContent = shown === null ? "—" : `${shown}${shown >= PACE_MAX ? "+" : ""}%`;
    }
    if (isBar) this.renderBar(r, all);
    else if (isGauge) {
      // A tenth of a degree is under a pixel at the tip at any size the HUD gets to.
      const angle = Math.round(gaugeAngle(live) * 10);
      if (all || angle !== this.lastAngle) this.turn.setRotate((this.lastAngle = angle) / 10, 0, 0);
    } else if (paceChanged || r.side !== this.lastSide) {
      this.marker.hidden = pace === null;
      this.marker.style.left = `${trainerPosition(pace ?? 100, r.side, this.p.follow) * 100}%`;
    }
    this.lastPace = pace;
    this.lastSide = r.side;
  }
  private renderBar(r: TrainerReading, all: boolean): void {
    const value = r.bar ?? r.pace;
    const edge = barEdge(r.barSide ?? r.side);
    if (all || edge !== this.lastEdge) this.el.dataset.edge = this.lastEdge = edge;
    const band = value === null ? "" : barBand(r.gain);
    if (all || band !== this.lastBand) this.el.dataset.band = this.lastBand = band;
    // A thousandth of the track is under a pixel at any size the HUD gets to. A transform, not a width: no layout.
    const fill = Math.round(barFill(value) * 1000);
    if (all || fill !== this.lastFill) {
      this.lastFill = fill;
      this.fill.style.transform = `scaleX(${fill / 1000})`;
    }
  }
}
