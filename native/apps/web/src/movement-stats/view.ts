// The movement HUD elements (layout ids longJump, strafeOffsets, firstJump, startPre): plain text over the game in the
// HUD face, numbers bold and tabular, labels dimmer. No boxes. hud.ts owns the elements and feeds these.
import { h } from "../ui/dom";
import { ljColor, ljColumns, offsetNote, plural, signedTicks, type LjReport, type OffsetReport } from "./stats";
import "./movement.css";

/** How long a jump stays up before it fades (a newer one replaces it at once). */
const LJ_SHOW_MS = 4000;

/** Last jump: "LJ 254.32" big, in its tier colour; pre / max / strafes / sync in fixed columns under it. */
export class LjView {
  readonly el = h("div.lj-hud");
  private kind = h("span.lj-kind");
  private dist = h("b.lj-dist");
  private fail = h("span.lj-fail", null, "fail");
  private cols = Array.from({ length: 4 }, () => ({ n: h("b"), l: h("span") }));
  private shown: LjReport | null = null;
  private held = false;
  private timer = 0;
  constructor() {
    this.el.append(h("div.lj-head", null, this.kind, this.dist, this.fail), h("div.lj-cols", null, ...this.cols.map((c) => h("span.lj-col", null, c.n, c.l))));
  }
  /** Shows `r` (null hides). `hold`: keep it up (the layout editor's sample). True if something is shown. */
  show(r: LjReport | null, hold = false): boolean {
    const fresh = r !== this.shown;
    if (!fresh && hold === this.held) return !!r;
    this.held = hold;
    clearTimeout(this.timer);
    this.el.classList.remove("lj-gone");
    if (r && !hold) this.timer = window.setTimeout(() => this.el.classList.add("lj-gone"), LJ_SHOW_MS);
    if (fresh) {
      this.shown = r;
      if (r) {
        this.kind.textContent = r.kind;
        this.dist.textContent = r.distance.toFixed(2);
        this.dist.style.color = ljColor(r);
        this.el.classList.toggle("lj-failed", !!r.failed);
        ljColumns(r).forEach(([n, l], i) => ((this.cols[i].n.textContent = n), (this.cols[i].l.textContent = l)));
        // Restart the entrance (a jump right after another still reads as new).
        this.el.classList.remove("lj-in");
        void this.el.offsetWidth;
        this.el.classList.add("lj-in");
      }
    }
    return !!r;
  }
}

/** "Offset −1 (key early, gap)": the number bold. */
export function offsetNodes(r: OffsetReport): (string | Node)[] {
  return ["Offset ", h("b", null, signedTicks(r.ticks)), h("span.mv-note", null, ` (${offsetNote(r)})`)];
}

/** "FJT 1 tick". */
export function fjtNodes(ticks: number): (string | Node)[] {
  const [n, ...rest] = plural(ticks, "tick").split(" ");
  return ["FJT ", h("b", null, n), ` ${rest.join(" ")}`];
}

/** "pre 276", beside the speed. */
export function startPreNodes(speed: number): (string | Node)[] {
  return [h("span.mv-note", null, "pre "), h("b", null, String(speed))];
}
