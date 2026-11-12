import { h } from "../ui/dom";
import { barBand, barEdge, barFill, PACE_MAX, trainerPosition, trainerZone, type TrainerReading, type TrainerCue } from "./strafe-trainer";
import type { TrainerPrefs } from "../ui/settings";
import "./strafe-trainer.css";

const LABELS: Record<TrainerCue, string> = {
  ready: "", keys: "strafe keys", direction: "match your turn",
  slow: "turn more", good: "", fast: "ease turn",
};
/** One element for every style (data-style switches the look in CSS); the rail spans 0 to PACE_MAX %. */
export class StrafeTrainerView {
  private number = h("b", null, "—");
  private cue = h("span.st-cue", null, LABELS.ready);
  private marker = h("i.st-marker");
  private fill = h("i.st-fill");
  readonly el = h("div.st-trainer", { "data-cue": "ready", "data-style": "classic", "aria-label": "Strafe trainer", title: "100% is the target mouse turn per simulation tick. Bar colour: red loses speed, white holds it, orange/green/blue gain more. Works in every style." },
    h("div.st-rail", { "aria-hidden": "true" }, h("span.st-band"), h("i.st-target"), this.marker, this.fill),
    h("div.st-reading", null, this.number, this.cue),
  );
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
  /**
   * Called every frame, and the Bar's fill changes nearly every tick: each write waits for its own value to change, so
   * the fill alone never touches the text. `lastJump` is the number under the Bar look (the others show the live pace).
   */
  render(r: TrainerReading, lastJump: number | null = null): void {
    const all = this.dirty;
    this.dirty = false;
    const isBar = this.p.style === "bar";
    const pace = r.pace === null ? null : Math.round(r.pace);
    const barPace = r.bar ?? r.pace;
    const cue = isBar
      ? r.gain == null || barPace === null ? "ready"
        : Math.abs(barPace - 100) <= 10 ? "good" : barPace < 100 ? "slow" : "fast"
      : r.cue;
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
    else if (paceChanged || r.side !== this.lastSide) {
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
