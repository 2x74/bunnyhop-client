// Hand-rolled SVG charts for the admin (no library): columns (stacked, for runs per hour, feedback and flags per day),
// a line with an optional band (players in rooms, verify latency), occupancy slots and a score ring.
//
// Rules (research/ADMIN-DESIGN.md "v0.0.10 iteration", and the dataviz mark specs):
//   - drawn at the host's real pixel width (a ResizeObserver redraws on resize), so strokes and text stay crisp;
//   - one zero baseline, a hairline; the only y label is the rounded top of the scale; no gridlines;
//   - columns at most 24 px wide, a 4 px rounded top and a square foot, stacked segments split by a 2 px gap of ground;
//   - lines 2 px, an area wash at ~10 %, the end point marked (r 4 with a ring of ground);
//   - colour by job: ink for counts, red for rejected / blatant (status), never amber (amber means "waiting for you");
//   - hover (or tap) shows a readout for the column or point under the pointer; the svg carries a text summary;
//   - first draw: columns grow from the baseline, a few ms apart (admin.css .chart.intro); reduced motion: none.

const NS = "http://www.w3.org/2000/svg";

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | null | undefined>, parent?: Element): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  parent?.append(n);
  return n;
}

/** The smallest "nice" number (1, 2, 2.5, 5 × 10^k) at or above v; at least `floor`. */
export function niceMax(v: number, floor = 1): number {
  const x = Math.max(v, floor);
  const k = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * k >= x) return m * k;
  return 10 * k;
}

export interface Series {
  values: number[];
  /** CSS class on the marks (admin.css .c-ink, .c-red, .c-dim). */
  cls: string;
  label: string;
}

interface Base {
  /** Accessible summary of what the chart shows (the svg's name). */
  label: string;
  height: number;
  /** x tick labels: [index, text]. */
  ticks?: [number, string][];
  /** The readout for column / point i. */
  tip: (i: number) => string;
  /** Format for the top-of-scale label. */
  fmt?: (v: number) => string;
  /** Grow in on the first draw. */
  intro?: boolean;
  /** No labels and almost no headroom: an inline chart a line tall (a sparkline). */
  bare?: boolean;
}

/** A host that redraws at its own width and owns a readout. */
function frame(o: Base, draw: (svg: SVGSVGElement, w: number, h: number) => { hit: (x: number) => number; mark: (i: number) => { x: number; y?: number } }): HTMLElement {
  const host = document.createElement("div");
  host.className = `chart${o.intro ? " intro" : ""}${o.bare ? " bare" : ""}`;
  host.style.height = `${o.height}px`;
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  let geo: ReturnType<typeof draw> | null = null;
  let svg: SVGSVGElement | null = null;
  let lastW = 0;
  const render = () => {
    const w = Math.round(host.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    svg?.remove();
    svg = s("svg", { width: w, height: o.height, viewBox: `0 0 ${w} ${o.height}`, role: "img", "aria-label": o.label, class: "chart-svg" });
    geo = draw(svg, w, o.height);
    host.prepend(svg);
    if (o.intro) setTimeout(() => host.classList.remove("intro"), 900);
  };
  new ResizeObserver(render).observe(host);
  const show = (clientX: number) => {
    if (!geo || !svg) return;
    const r = svg.getBoundingClientRect();
    const i = geo.hit(clientX - r.left);
    if (i < 0) return hide();
    svg.querySelectorAll(".on").forEach((n) => n.classList.remove("on"));
    svg.querySelectorAll(`[data-i="${i}"]`).forEach((n) => n.classList.add("on"));
    const m = geo.mark(i);
    tip.textContent = o.tip(i);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(0, Math.min(lastW - tw, m.x - tw / 2))}px`;
    host.classList.add("hover");
  };
  const hide = () => {
    tip.hidden = true;
    host.classList.remove("hover");
    svg?.querySelectorAll(".on").forEach((n) => n.classList.remove("on"));
  };
  host.addEventListener("pointermove", (e) => show(e.clientX));
  host.addEventListener("pointerdown", (e) => show(e.clientX));
  host.addEventListener("pointerleave", hide);
  host.append(tip);
  return host;
}

const PAD_TOP = 18; // room for the top-of-scale label
const PAD_BOTTOM = 20; // x ticks

const padTop = (o: Base) => (o.bare ? 3 : PAD_TOP);

function axis(svg: SVGSVGElement, w: number, h: number, top: number, o: Base, xAt: (i: number) => number): void {
  const base = h - (o.ticks ? PAD_BOTTOM : 1);
  s("line", { x1: 0, x2: w, y1: base + 0.5, y2: base + 0.5, class: "chart-base" }, svg);
  if (o.bare) return;
  const lab = s("text", { x: 0, y: 11, class: "chart-max" }, svg);
  lab.textContent = (o.fmt ?? ((v: number) => v.toLocaleString()))(top);
  for (const [i, t] of o.ticks ?? []) {
    const x = xAt(i);
    const anchor = x < 24 ? "start" : x > w - 24 ? "end" : "middle";
    const el = s("text", { x: anchor === "start" ? 0 : anchor === "end" ? w : x, y: h - 5, "text-anchor": anchor, class: "chart-tick" }, svg);
    el.textContent = t;
  }
}

/** Columns, stacked bottom to top in `series` order. `hot`: the index drawn brighter (the current hour). */
export function columns(o: Base & { series: Series[]; hot?: number }): HTMLElement {
  const n = o.series[0]?.values.length ?? 0;
  const totals = Array.from({ length: n }, (_, i) => o.series.reduce((a, sr) => a + (sr.values[i] ?? 0), 0));
  return frame(o, (svg, w, h) => {
    const base = h - (o.ticks ? PAD_BOTTOM : 1);
    const plot = base - padTop(o);
    const top = niceMax(Math.max(0, ...totals));
    const band = w / Math.max(1, n);
    const bw = Math.min(24, Math.max(2, band * 0.62));
    const xAt = (i: number) => band * i + band / 2;
    axis(svg, w, h, top, o, xAt);
    const g = s("g", { class: "cols" }, svg);
    for (let i = 0; i < n; i++) {
      // the hover band, full height, behind the column
      s("rect", { x: band * i, y: 0, width: band, height: base, class: "col-hit", "data-i": i }, g);
      let y = base;
      const col = s("g", { class: `col${i === o.hot ? " hot" : ""}`, "data-i": i, style: `--i:${i}` }, g);
      const segs = o.series.map((sr) => ({ v: sr.values[i] ?? 0, cls: sr.cls })).filter((x) => x.v > 0);
      segs.forEach((seg, k) => {
        const last = k === segs.length - 1;
        const hgt = Math.max(2, (seg.v / top) * plot) - (k > 0 ? 2 : 0); // 2 px gap of ground under a stacked segment
        y -= hgt + (k > 0 ? 2 : 0);
        const x = xAt(i) - bw / 2;
        const r = last ? Math.min(4, bw / 2, hgt) : 0;
        // a rounded top and a square foot
        s(
          "path",
          {
            d: `M${x},${y + hgt} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${y + hgt} Z`,
            class: `seg ${seg.cls}`,
          },
          col,
        );
      });
      if (!segs.length) s("rect", { x: xAt(i) - bw / 2, y: base - 1, width: bw, height: 1, class: "seg empty" }, col);
    }
    return { hit: (x) => (n ? Math.max(0, Math.min(n - 1, Math.floor(x / band))) : -1), mark: (i) => ({ x: xAt(i) }) };
  });
}

/**
 * A line over evenly spaced points (or at `xs`, 0..1), with gaps where a value is null. `band`: an upper series drawn as
 * a wash between it and the line (the p90 above the median). `area`: a wash under the line.
 */
export function line(o: Base & { values: (number | null)[]; band?: (number | null)[]; xs?: number[]; area?: boolean; cls?: string }): HTMLElement {
  const n = o.values.length;
  return frame(o, (svg, w, h) => {
    const base = h - (o.ticks ? PAD_BOTTOM : 1);
    const plot = base - padTop(o);
    const vals = [...o.values, ...(o.band ?? [])].filter((v): v is number => v !== null);
    const top = niceMax(Math.max(0, ...vals));
    const inset = o.bare ? 3 : 5; // the end dot's radius + ring stays inside
    const xAt = (i: number) => inset + (o.xs ? o.xs[i] : n > 1 ? i / (n - 1) : 0.5) * (w - inset * 2);
    const yAt = (v: number) => base - (v / top) * plot;
    axis(svg, w, h, top, o, xAt);
    const runs: number[][] = [];
    let cur: number[] = [];
    o.values.forEach((v, i) => {
      if (v === null) {
        if (cur.length) runs.push(cur);
        cur = [];
      } else cur.push(i);
    });
    if (cur.length) runs.push(cur);
    const cls = o.cls ?? "c-ink";
    for (const r of runs) {
      const pts = r.map((i) => `${xAt(i).toFixed(1)},${yAt(o.values[i]!).toFixed(1)}`);
      if (o.band) {
        const up = r.map((i) => `${xAt(i).toFixed(1)},${yAt(o.band![i] ?? o.values[i]!).toFixed(1)}`);
        s("path", { d: `M${up.join(" L")} L${[...pts].reverse().join(" L")} Z`, class: `band ${cls}` }, svg);
      }
      if (o.area) s("path", { d: `M${xAt(r[0]).toFixed(1)},${base} L${pts.join(" L")} L${xAt(r[r.length - 1]).toFixed(1)},${base} Z`, class: `area ${cls}` }, svg);
      if (r.length === 1) s("circle", { cx: xAt(r[0]), cy: yAt(o.values[r[0]]!), r: 2, class: `pt ${cls}` }, svg);
      else s("path", { d: `M${pts.join(" L")}`, class: `stroke ${cls}`, pathLength: 1 }, svg);
    }
    const last = [...o.values.keys()].reverse().find((i) => o.values[i] !== null);
    if (last !== undefined) s("circle", { cx: xAt(last), cy: yAt(o.values[last]!), r: o.bare ? 2.5 : 4, class: `end ${cls}` }, svg);
    // hover: a crosshair and a dot per point
    const hair = s("g", { class: "hair" }, svg);
    o.values.forEach((v, i) => {
      if (v === null) return;
      const g = s("g", { class: "hp", "data-i": i }, hair);
      s("line", { x1: xAt(i), x2: xAt(i), y1: Math.max(0, padTop(o) - 4), y2: base, class: "hp-line" }, g);
      s("circle", { cx: xAt(i), cy: yAt(v), r: 4, class: `hp-dot ${cls}` }, g);
    });
    const hit = (x: number) => {
      let best = -1;
      let d = Infinity;
      o.values.forEach((v, i) => {
        if (v === null) return;
        const dd = Math.abs(xAt(i) - x);
        if (dd < d) (d = dd), (best = i);
      });
      return best;
    };
    return { hit, mark: (i) => ({ x: xAt(i) }) };
  });
}

/** Room occupancy: one small square per slot, filled for each player (amber when nearly full). */
export function slots(players: number, max: number): SVGSVGElement {
  const size = 5;
  const gap = 2;
  const per = max > 24 ? Math.ceil(max / 2) : max;
  const rows = Math.ceil(max / per);
  const w = per * (size + gap) - gap;
  const h = rows * (size + gap) - gap;
  const svg = s("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}`, class: `slots${max && players / max >= 0.8 ? " full" : ""}`, "aria-hidden": "true" });
  for (let i = 0; i < max; i++) {
    s("rect", { x: (i % per) * (size + gap), y: Math.floor(i / per) * (size + gap), width: size, height: size, rx: 1.2, class: i < players ? "on" : "" }, svg);
  }
  return svg;
}

/** A 0-100 score as a small ring (red from 90, amber from 70: admin.css). */
export function ring(score: number): SVGSVGElement {
  const r = 7;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, score)) / 100;
  const svg = s("svg", { width: 20, height: 20, viewBox: "0 0 20 20", class: "ring", "aria-hidden": "true" });
  s("circle", { cx: 10, cy: 10, r, class: "ring-track" }, svg);
  s("circle", { cx: 10, cy: 10, r, class: "ring-fill", "stroke-dasharray": `${(v * c).toFixed(2)} ${c.toFixed(2)}`, transform: "rotate(-90 10 10)" }, svg);
  return svg;
}

/** A thin progress line (0..1), e.g. how far a room is into its map. */
export function progress(f: number): HTMLElement {
  const el = document.createElement("span");
  el.className = "prog";
  el.setAttribute("aria-hidden", "true");
  const i = document.createElement("i");
  i.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
  el.append(i);
  return el;
}

/** One jump of a run's analysis: [air ticks, takeoff speed, landing speed, gain ‰, sync ‰, strafes] (input-analysis.ts JumpRow). */
export type JumpRow = [number, number, number, number | null, number | null, number];

/**
 * The jump strip (L4): one bar per jump, its height the jump's gain; the best 6-jump window in amber; a thin ink line
 * over the bars is sync. The same numbers the game's jump stats show players. Hover reads a jump out; `onPick` hears a
 * click (the case view opens the replay at that jump). Columns grow once on the first draw.
 */
export function jumpStrip(rows: JumpRow[], o: { best: Set<number>; height?: number; onPick?: (i: number) => void }): HTMLElement {
  const H = o.height ?? 96;
  const pct = (v: number | null) => (v === null ? "–" : `${(v / 10).toFixed(1)}%`);
  const host = frame(
    {
      label: `Gain per jump over ${rows.length} jumps; the best 6-jump window is highlighted.`,
      height: H,
      intro: true,
      ticks: rows.length > 1 ? [[0, "1"], [rows.length - 1, String(rows.length)]] : undefined,
      tip: (i) => {
        const r = rows[i];
        return `Jump ${i + 1}: ${r[0]} ticks in the air, ${r[1]} → ${r[2]} u/s, gain ${pct(r[3])}, sync ${r[4] === null ? "–" : `${Math.round(r[4] / 10)}%`}${o.best.has(i) ? ", best window" : ""}`;
      },
    },
    (svg, w, h) => {
      const base = h - PAD_BOTTOM;
      const top = 14;
      const plot = base - top;
      const n = rows.length;
      const band = w / Math.max(1, n);
      const bw = Math.min(18, Math.max(2, band * 0.66));
      const xAt = (i: number) => band * i + band / 2;
      const lab = s("text", { x: 0, y: 10, class: "chart-max" }, svg);
      lab.textContent = "gain";
      s("line", { x1: 0, x2: w, y1: base + 0.5, y2: base + 0.5, class: "chart-base" }, svg);
      // 100% gain, a faint guide.
      s("line", { x1: 0, x2: w, y1: top + 0.5, y2: top + 0.5, class: "strip-guide" }, svg);
      const g = s("g", { class: "cols" }, svg);
      rows.forEach((r, i) => {
        s("rect", { x: band * i, y: 0, width: band, height: base, class: "col-hit", "data-i": i }, g);
        const col = s("g", { class: `col strip-col${o.best.has(i) ? " best" : ""}${r[3] === null ? " none" : ""}`, "data-i": i, style: `--i:${i}` }, g);
        const v = r[3] === null ? 0.02 : Math.max(0.02, Math.min(1, r[3] / 1000));
        const hh = v * plot;
        s("rect", { x: xAt(i) - bw / 2, y: base - hh, width: bw, height: hh, rx: Math.min(2, bw / 2), class: "seg" }, col);
      });
      // Sync: a thin line over the bars.
      const pts = rows.map((r, i) => (r[4] === null ? null : `${xAt(i).toFixed(1)},${(base - Math.min(1, r[4] / 1000) * plot).toFixed(1)}`));
      const runs: string[][] = [];
      let cur: string[] = [];
      for (const p of pts) {
        if (p === null) {
          if (cur.length) runs.push(cur);
          cur = [];
        } else cur.push(p);
      }
      if (cur.length) runs.push(cur);
      for (const r of runs) if (r.length > 1) s("path", { d: `M${r.join(" L")}`, class: "strip-sync", pathLength: 1 }, svg);
      const t = s("text", { x: w, y: 10, "text-anchor": "end", class: "chart-max" }, svg);
      t.textContent = "sync";
      return { hit: (x) => (n ? Math.max(0, Math.min(n - 1, Math.floor(x / band))) : -1), mark: (i) => ({ x: xAt(i) }) };
    },
  );
  host.classList.add("strip");
  if (o.onPick)
    host.addEventListener("click", (e) => {
      const svg = host.querySelector("svg");
      if (!svg) return;
      const r = svg.getBoundingClientRect();
      const i = Math.floor(((e.clientX - r.left) / r.width) * rows.length);
      if (i >= 0 && i < rows.length) o.onPick!(i);
    });
  return host;
}
