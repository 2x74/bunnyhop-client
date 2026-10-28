// The replay viewer's gauntlet layer (gauntlet/watch.ts): while a whole gauntlet attempt is watched, one bar across
// the gauntlet above the viewer's timeline (a segment per map, as long as its split; the current one fills as it
// plays; a click goes to that map), "Map 2 of 3" with the map, and the gauntlet clock (the earlier splits plus this
// run) with the record's split for this map. When a run ends the next map's name shows, then its page loads (its BSP
// was prefetched meanwhile). N / P: next / previous map. The viewer (viewer.ts) calls frame / ended / key.

import type { GauntletWatchPlan } from "../api";
import { bspUrl } from "../content/map-url";
import { formatDelta } from "../hud/time-face";
import { allowLeave } from "../play-lock";
import { h } from "../ui/dom";
import { gauntletTime } from "../gauntlet/state";
import { gauntletClock, segments, watchPath } from "../gauntlet/watch";
import type { RunData } from "./player";

/** After a run ends: this long on the next map's name before it loads. */
const NEXT_MS = 2500;

export class GauntletLayer {
  readonly el: HTMLElement;
  readonly overlay: HTMLElement;
  private fills: HTMLElement[] = [];
  private clock = h("b.rv-gx-clock");
  private gap = h("span.rv-gx-gap");
  private times: number[];
  private timer = 0;
  private done = false;

  constructor(
    private plan: GauntletWatchPlan,
    readonly idx: number,
  ) {
    this.times = plan.splits.map((s) => s.time);
    const cur = plan.splits[idx];
    const segs = segments(this.times);
    const bar = h(
      "div.rv-gx-bar",
      { role: "group", "aria-label": "Maps" },
      ...segs.map((sg) => {
        const s = plan.splits[sg.idx];
        const fill = h("span.rv-gx-fill");
        this.fills.push(fill);
        return h(
          `button.rv-gx-seg${sg.idx === idx ? ".cur" : sg.idx < idx ? ".past" : ""}`,
          { type: "button", style: `width:${(sg.width * 100).toFixed(3)}%`, title: `${sg.idx + 1}. ${s.map}  ${gauntletTime(s.time)}`, "aria-label": `Map ${sg.idx + 1}, ${s.map}`, onclick: () => this.go(sg.idx) },
          fill,
          h("span.rv-gx-name", null, s.map),
        );
      }),
    );
    const rec = plan.record && plan.record.attemptId !== plan.attemptId ? plan.record : null;
    const record = rec?.splits.find((s) => s.idx === idx);
    this.el = h(
      "div.rv-gx",
      null,
      h("div.rv-gx-pos", null, h("span", null, `Map ${idx + 1} of ${plan.splits.length}`), h("b", null, cur?.map ?? "")),
      bar,
      h(
        "div.rv-gx-time",
        null,
        this.clock,
        rec && record ? h("span.rv-gx-rec", { title: `${rec.player.name}'s split on this map` }, `Record ${gauntletTime(record.time)}`, this.gap) : null,
      ),
    );
    this.overlay = h("div.rv-gx-next", { hidden: true });
    window.setTimeout(() => void this.prefetchNext(), 3000);
  }

  /** Each viewer frame: the current segment's fill and the gauntlet clock. */
  frame(d: RunData, t: number): void {
    const cur = this.times[this.idx] ?? 0;
    const run = Math.max(0, (t - d.startTick) * d.interval);
    const frac = cur > 0 ? Math.min(1, run / cur) : t >= d.n ? 1 : 0;
    this.fills.forEach((f, i) => (f.style.transform = `scaleX(${i < this.idx ? 1 : i === this.idx ? frac : 0})`));
    this.clock.textContent = gauntletTime(gauntletClock(this.times, this.idx, run));
    const record = this.plan.record && this.plan.record.attemptId !== this.plan.attemptId ? this.plan.record.splits.find((s) => s.idx === this.idx) : undefined;
    const done = d.endTick > 0 && t >= d.endTick;
    this.gap.textContent = done && record ? ` ${formatDelta(cur - record.time)}` : "";
    this.gap.className = `rv-gx-gap${done && record ? (cur < record.time ? " ahead" : " behind") : ""}`;
  }

  /** The run played to its end: the next map's name, then its page. The last map: the gauntlet's total. */
  ended(): void {
    if (this.done) return;
    this.done = true;
    const next = this.plan.splits[this.idx + 1];
    const total = this.times.reduce((a, b) => a + b, 0);
    this.overlay.replaceChildren(
      ...(next
        ? [h("span", null, `Map ${next.idx + 1} of ${this.plan.splits.length}`), h("b", null, next.map)]
        : [h("span", null, `${this.plan.player.name} cleared ${this.plan.gauntlet.title}`), h("b", null, gauntletTime(total))]),
    );
    this.overlay.hidden = false;
    if (next) this.timer = window.setTimeout(() => this.go(this.idx + 1), NEXT_MS);
  }

  /** N / P: next / previous map. */
  key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    if (e.code === "KeyN" && this.idx + 1 < this.plan.splits.length) return this.go(this.idx + 1), true;
    if (e.code === "KeyP" && this.idx > 0) return this.go(this.idx - 1), true;
    return false;
  }

  /** Back to the gauntlet's page (closing the viewer). */
  leave(): void {
    this.dispose();
    allowLeave();
    location.href = `/g/${encodeURIComponent(this.plan.gauntlet.slug)}`;
  }

  go(idx: number): void {
    if (idx === this.idx && !this.done) return;
    window.clearTimeout(this.timer);
    allowLeave();
    location.href = watchPath(this.plan.gauntlet.slug, this.plan.attemptId, idx);
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    this.el.remove();
    this.overlay.remove();
  }

  /** The next map's BSP (its run's build) into the HTTP cache, so its page loads from it. */
  private async prefetchNext(): Promise<void> {
    const next = this.plan.splits[this.idx + 1];
    if (!next || !this.el.isConnected) return;
    try {
      const res = await fetch(bspUrl(next.map, next.mapSha256), { priority: "low" } as RequestInit);
      const reader = res.ok ? res.body?.getReader() : null;
      while (reader && !(await reader.read()).done) {
        /* drained into the cache */
      }
    } catch {
      /* its page downloads it as usual */
    }
  }
}
