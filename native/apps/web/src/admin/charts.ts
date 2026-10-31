// Hand-rolled SVG charts for the admin (no library): columns (stacked, for runs per hour, feedback and flags per day),
// a line with an optional band (players in rooms, verify latency), several lines, horizontal bars, donuts, circular bars,
// occupancy slots and a score ring.
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

/**
 * Several lines over the same evenly spaced points, one y scale (Analytics' retention curve). A hairline finds the x, and
 * the readout lists every series there. Gaps where a value is null. Keep to four series; colour them .s-1 to .s-4, or
 * c-ink for the one that is context (admin.css: validated on the panel's ground).
 */
export function lines(o: Base & { series: { values: (number | null)[]; cls: string; label: string }[]; top?: number }): HTMLElement {
  const n = Math.max(0, ...o.series.map((sr) => sr.values.length));
  return frame(o, (svg, w, h) => {
    const base = h - (o.ticks ? PAD_BOTTOM : 1);
    const plot = base - padTop(o);
    const top = o.top || niceMax(Math.max(0, ...o.series.flatMap((sr) => sr.values.filter((v): v is number => v !== null))));
    const inset = 5;
    const xAt = (i: number) => inset + (n > 1 ? i / (n - 1) : 0.5) * (w - inset * 2);
    const yAt = (v: number) => base - (v / top) * plot;
    axis(svg, w, h, top, o, xAt);
    for (const sr of o.series) {
      let path = "";
      let last = -1;
      sr.values.forEach((v, i) => {
        if (v === null) return;
        path += `${last === i - 1 && last >= 0 ? "L" : "M"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)} `;
        last = i;
      });
      if (path) s("path", { d: path.trim(), class: `stroke ${sr.cls}` }, svg);
      if (last >= 0) s("circle", { cx: xAt(last), cy: yAt(sr.values[last]!), r: 4, class: `end ${sr.cls}` }, svg);
    }
    const hair = s("g", { class: "hair" }, svg);
    const has = (i: number) => o.series.some((sr) => sr.values[i] !== null && sr.values[i] !== undefined);
    for (let i = 0; i < n; i++) {
      if (!has(i)) continue;
      const g = s("g", { class: "hp", "data-i": i }, hair);
      s("line", { x1: xAt(i), x2: xAt(i), y1: Math.max(0, padTop(o) - 4), y2: base, class: "hp-line" }, g);
      for (const sr of o.series) {
        const v = sr.values[i];
        if (v !== null && v !== undefined) s("circle", { cx: xAt(i), cy: yAt(v), r: 4, class: `hp-dot ${sr.cls}` }, g);
      }
    }
    const hit = (x: number) => {
      let best = -1;
      let d = Infinity;
      for (let i = 0; i < n; i++) {
        if (!has(i)) continue;
        const dd = Math.abs(xAt(i) - x);
        if (dd < d) (d = dd), (best = i);
      }
      return best;
    };
    return { hit, mark: (i) => ({ x: xAt(i) }) };
  });
}

export interface BarRow {
  label: string;
  value: number;
  /** The figure at the bar's tip. */
  shown: string;
  /** The readout on hover or focus. */
  tip?: string;
  /** A class for the bar: .r-1 to .r-5 for ordered stages (admin.css); default ink. */
  cls?: string;
}

/**
 * Horizontal bars for long or many names (Analytics): plain rows, so a name wraps instead of clipping and the row is the
 * hover target. A 4 px rounded data end, a square foot, at most 14 px thick; the value at the tip. `max`: the scale's top.
 */
export function hbars(o: { rows: BarRow[]; label: string; max?: number }): HTMLElement {
  const host = document.createElement("div");
  host.className = "hb";
  host.setAttribute("role", "list");
  host.setAttribute("aria-label", o.label);
  const top = o.max ?? Math.max(0, ...o.rows.map((r) => r.value));
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  for (const r of o.rows) {
    const row = document.createElement("div");
    row.className = "hb-row";
    row.setAttribute("role", "listitem");
    row.tabIndex = 0;
    const name = document.createElement("span");
    name.className = "hb-label";
    name.textContent = r.label;
    const track = document.createElement("span");
    track.className = "hb-track";
    const bar = document.createElement("i");
    bar.className = `hb-bar${r.cls ? ` ${r.cls}` : ""}`;
    bar.style.width = `${top > 0 ? Math.max(0.5, (r.value / top) * 100) : 0}%`;
    track.append(bar);
    const val = document.createElement("span");
    val.className = "hb-val";
    val.textContent = r.shown;
    row.append(name, track, val);
    if (r.tip) {
      const show = () => {
        tip.textContent = r.tip!;
        tip.hidden = false;
        tip.style.left = `${Math.max(0, row.offsetLeft)}px`;
        tip.style.top = `${row.offsetTop - 6}px`;
      };
      const hide = () => (tip.hidden = true);
      row.addEventListener("pointerenter", show);
      row.addEventListener("pointerleave", hide);
      row.addEventListener("focus", show);
      row.addEventListener("blur", hide);
    }
    host.append(row);
  }
  host.append(tip);
  return host;
}

// ---------------------------------------------------------------------------------------------
// Donuts and circular bars (Analytics). A mark responds to hover, keyboard focus and touch: it stays lit and the others
// dim (no glow), a readout names it, and a tap elsewhere lets go. Colours come in as CSS values (chart-colors.ts), set as
// --c on each mark. The 2 px between slices is each slice's own stroke in the ground colour.

let letGoLast: (() => void) | null = null;
let tapWired = false;

interface MarkWiring {
  /** Elements that light up. */
  lit: Element[];
  /** Elements that pick it. */
  targets: Element[];
  /** The readout. */
  tip: string;
}

function wireMarks(host: HTMLElement, marks: MarkWiring[], onPick?: (i: number | null) => void): void {
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  host.append(tip);
  let current = -1;
  const letGo = () => {
    if (current >= 0) for (const el of marks[current].lit) el.classList.remove("on");
    current = -1;
    tip.hidden = true;
    host.classList.remove("has-on");
    onPick?.(null);
    if (letGoLast === letGo) letGoLast = null;
  };
  const place = (x: number, y: number) => {
    const r = host.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    // Over the mark if it fits on screen, else under it; never off the sides.
    const left = Math.max(4 - r.left, Math.min(innerWidth - r.left - w - 4, x - r.left - w / 2));
    const above = y - h - 12 >= 0;
    tip.style.left = `${left}px`;
    tip.style.top = `${(above ? y - 10 : y + h + 18) - r.top}px`;
  };
  const pick = (i: number, x: number, y: number) => {
    if (i !== current) {
      if (letGoLast && letGoLast !== letGo) letGoLast();
      if (current >= 0) for (const el of marks[current].lit) el.classList.remove("on");
      current = i;
      letGoLast = letGo;
      for (const el of marks[i].lit) el.classList.add("on");
      host.classList.add("has-on");
      tip.textContent = marks[i].tip;
      tip.hidden = false;
      onPick?.(i);
    }
    place(x, y);
  };
  const centre = (el: Element) => {
    const b = el.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2] as const;
  };
  marks.forEach((m, i) => {
    for (const t of m.targets) {
      const el = t as HTMLElement;
      el.dataset.mark = "1";
      el.addEventListener("pointerenter", (e) => e.pointerType !== "touch" && pick(i, e.clientX, e.clientY));
      el.addEventListener("pointermove", (e) => e.pointerType !== "touch" && pick(i, e.clientX, e.clientY));
      el.addEventListener("pointerleave", (e) => e.pointerType !== "touch" && !el.matches(":focus-visible") && letGo());
      // A tap picks; a second tap on the same mark lets go.
      el.addEventListener("pointerdown", (e) => {
        if (e.pointerType !== "touch") return;
        if (current === i) letGo();
        else pick(i, e.clientX, e.clientY);
      });
      el.addEventListener("focus", () => {
        if (el.matches(":focus-visible")) pick(i, ...centre(el));
      });
      el.addEventListener("blur", letGo);
    }
  });
  if (!tapWired) {
    tapWired = true;
    document.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch" && !(e.target as Element | null)?.closest?.("[data-mark]")) letGoLast?.();
    });
  }
}

/** A point at angle `a` (radians, clockwise from 12 o'clock). */
const polar = (cx: number, cy: number, r: number, a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const;
const f1 = (v: number) => v.toFixed(2);

/** An annular sector from a0 to a1. */
export function sectorPath(cx: number, cy: number, inner: number, outer: number, a0: number, a1: number): string {
  // A whole ring: stop a hair short so the arcs have two distinct ends.
  const end = Math.min(a1, a0 + Math.PI * 2 - 0.0005);
  const large = end - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, outer, a0);
  const [x1, y1] = polar(cx, cy, outer, end);
  const [x2, y2] = polar(cx, cy, inner, end);
  const [x3, y3] = polar(cx, cy, inner, a0);
  return `M${f1(x0)},${f1(y0)} A${outer},${outer} 0 ${large} 1 ${f1(x1)},${f1(y1)} L${f1(x2)},${f1(y2)} A${inner},${inner} 0 ${large} 0 ${f1(x3)},${f1(y3)} Z`;
}

/** Sweeps for the values against a whole; slices too thin to see or hit get a minimum, taken from the others. */
export function sweeps(values: number[], whole: number, min = 0.05): number[] {
  const raw = values.map((v) => (Math.max(0, v) / Math.max(whole, 1e-9)) * Math.PI * 2);
  const thin = raw.filter((a) => a > 0 && a < min).length;
  const roomy = raw.filter((a) => a >= min).reduce((a, b) => a + b, 0);
  const total = raw.reduce((a, b) => a + b, 0);
  const scale = roomy > 0 ? Math.max(0, total - thin * min) / roomy : 1;
  return raw.map((a) => (a <= 0 ? 0 : a < min ? min : a * scale));
}

export interface Slice {
  label: string;
  value: number;
  color: string;
  /** Beside the name and in the centre. */
  shown: string;
  /** The readout: name, percentage, count, sample size. */
  tip: string;
}

/**
 * A donut with its legend. The centre says the sample until a slice is picked, then that slice's value and name. `whole`
 * (default: the sum) leaves a gap for what the chart doesn't show, like groups too small to name.
 */
export function donut(o: { slices: Slice[]; label: string; center: { value: string; label: string }; whole?: number }): HTMLElement {
  const host = document.createElement("div");
  host.className = "dn";
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", o.label);
  const SIZE = 150;
  const C = SIZE / 2;
  const OUTER = C - 4;
  const INNER = OUTER - 22;
  const ring = document.createElement("div");
  ring.className = "dn-ring";
  const svg = s("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, class: "dn-svg" }, ring);
  const whole = o.whole ?? o.slices.reduce((a, x) => a + x.value, 0);
  const angles = sweeps(o.slices.map((x) => x.value), whole);
  const centre = document.createElement("div");
  centre.className = "dn-center";
  const big = document.createElement("b");
  const small = document.createElement("span");
  centre.append(big, small);
  const rest = () => {
    big.textContent = o.center.value;
    small.textContent = o.center.label;
  };
  rest();
  ring.append(centre);
  const legend = document.createElement("ul");
  legend.className = "dn-legend";
  let at = 0;
  const marks: MarkWiring[] = o.slices.map((x, i) => {
    const mid = at + angles[i] / 2;
    const path = s("path", { d: sectorPath(C, C, INNER, OUTER, at, at + angles[i]), class: "dn-slice", tabindex: 0, role: "img", "aria-label": x.tip.replace(/\n/g, ", "), style: `--c:${x.color};--dx:${f1(Math.sin(mid) * 3)}px;--dy:${f1(-Math.cos(mid) * 3)}px` }, svg);
    at += angles[i];
    const row = document.createElement("li");
    row.style.setProperty("--c", x.color);
    const key = document.createElement("i");
    key.className = "dn-key";
    const name = document.createElement("span");
    name.className = "dn-name";
    name.textContent = x.label;
    const val = document.createElement("span");
    val.className = "dn-val";
    val.textContent = x.shown;
    row.append(key, name, val);
    legend.append(row);
    return { lit: [path, row], targets: [path, row], tip: x.tip };
  });
  host.append(ring, legend);
  wireMarks(host, marks, (i) => {
    if (i === null) return rest();
    big.textContent = o.slices[i].shown;
    small.textContent = o.slices[i].label;
  });
  return host;
}

export interface RingRow {
  label: string;
  value: number;
  color: string;
  /** Written after the name. */
  shown: string;
  tip: string;
}

/** Rough width of a label at the chart's type size, to shorten one that won't fit: the table has the whole name. */
const fitLabel = (label: string, room: number, charWidth = 5.5) => (label.length * charWidth <= room ? label : `${label.slice(0, Math.max(3, Math.floor(room / charWidth) - 1))}…`);

/**
 * Circular bars: one ring per row, outermost first, each swept clockwise from 12 o'clock in proportion to its value, the
 * biggest going three quarters round. The quarter left free holds the names, each level with its ring. The whole ring
 * (track, name and all) is the target, so a short bar is as easy to hit as a long one.
 */
export function radial(o: { rows: RingRow[]; label: string; max?: number }): HTMLElement {
  const host = document.createElement("div");
  host.className = "rb";
  host.setAttribute("role", "group");
  host.setAttribute("aria-label", o.label);
  const n = o.rows.length;
  const W = 262;
  const PITCH = n <= 3 ? 19 : n <= 5 ? 15 : n <= 7 ? 12.5 : 10.5;
  const THICK = PITCH - 2.5;
  const INNER = n <= 3 ? 22 : 16;
  const R = INNER + (n - 0.5) * PITCH;
  const edge = R + THICK / 2 + 1;
  const cx = W - edge;
  const cy = edge;
  const H = Math.ceil(edge * 2);
  const FULL = Math.PI * 1.5;
  const top = o.max ?? Math.max(0, ...o.rows.map((r) => r.value));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "rb-svg" });
  const arc = (r: number, a: number) => {
    const [x0, y0] = polar(cx, cy, r, 0);
    const [x1, y1] = polar(cx, cy, r, a);
    return `M${f1(x0)},${f1(y0)} A${r},${r} 0 ${a > Math.PI ? 1 : 0} 1 ${f1(x1)},${f1(y1)}`;
  };
  const marks: MarkWiring[] = o.rows.map((row, i) => {
    const r = R - i * PITCH;
    const g = s("g", { class: "rb-ring", tabindex: 0, role: "img", "aria-label": row.tip.replace(/\n/g, ", "), style: `--c:${row.color}` }, svg);
    s("path", { d: arc(r, FULL), class: "rb-track", "stroke-width": THICK }, g);
    const a = top > 0 ? Math.max(0.05, (row.value / top) * FULL) : 0;
    if (a > 0) {
      s("path", { d: arc(r, a), class: "rb-arc", "stroke-width": THICK }, g);
      const [ex, ey] = polar(cx, cy, r, a);
      s("circle", { cx: f1(ex), cy: f1(ey), r: THICK / 2, class: "rb-cap" }, g);
    }
    // The whole ring and the gap beside it, painted or not.
    s("path", { d: arc(r, FULL), class: "rb-hit", "stroke-width": PITCH }, g);
    const room = cx - 8;
    const shownWidth = row.shown.length * 6 + 6;
    const text = s("text", { x: f1(cx - 7), y: f1(cy - r + 3.6), "text-anchor": "end", class: "rb-label" }, g);
    const name = s("tspan", {}, text);
    name.textContent = fitLabel(row.label, room - shownWidth);
    const val = s("tspan", { dx: 5, class: "rb-val" }, text);
    val.textContent = row.shown;
    return { lit: [g], targets: [g], tip: row.tip };
  });
  host.append(svg);
  wireMarks(host, marks);
  return host;
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
