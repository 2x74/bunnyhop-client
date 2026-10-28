import { h } from "../ui/dom";
import { PACE_MAX, trainerPosition, trainerZone, type TrainerReading, type TrainerCue } from "./strafe-trainer";
import type { TrainerPrefs } from "../ui/settings";
import "./strafe-trainer.css";

const LABELS: Record<TrainerCue, string> = {
  ready: "", keys: "A / D", direction: "match your turn",
  slow: "turn more", good: "", fast: "ease turn", unsupported: "manual A/D only",
};
/** One element for every style (data-style switches the look in CSS); the rail spans 0 to PACE_MAX %. */
export class StrafeTrainerView {
  private number = h("b", null, "—");
  private cue = h("span.st-cue", null, LABELS.ready);
  private marker = h("i.st-marker");
  readonly el = h("div.st-trainer", { "data-cue": "ready", "data-style": "classic", "aria-label": "Strafe trainer", title: "Turn pace, not gain: 100% is the target mouse turn per simulation tick. Normal, EZ Scroll, Legit Scroll and Half-Sideways." },
    h("div.st-rail", { "aria-hidden": "true" }, h("span.st-band"), h("i.st-target"), this.marker),
    h("div.st-reading", null, this.number, this.cue),
  );
  private p: Pick<TrainerPrefs, "follow" | "zone" | "dimBelow"> = { follow: false, zone: 10, dimBelow: 0 };
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
    this.last = "";
  }
  private last = "";
  render(r: TrainerReading): void {
    const pace = r.pace === null ? null : Math.round(r.pace);
    const key = `${r.cue}:${pace}:${r.side}`;
    if (key === this.last) return;
    this.last = key;
    this.el.dataset.cue = r.cue;
    this.el.dataset.zone = pace === null ? "" : trainerZone(pace, this.p.zone);
    this.el.classList.toggle("st-dim", this.p.dimBelow > 0 && (pace === null || pace < this.p.dimBelow));
    this.number.textContent = pace === null ? "—" : `${pace}${pace >= PACE_MAX ? "+" : ""}%`;
    this.cue.textContent = LABELS[r.cue];
    this.marker.hidden = pace === null;
    this.marker.style.left = `${trainerPosition(pace ?? 100, r.side, this.p.follow) * 100}%`;
  }
}
