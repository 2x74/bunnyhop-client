// Shared form controls for the settings screen (and anything that registers a settings section, see
// settings-registry.ts). Every control is a `.set-row` reading  label · hint  |  control : the label on the left with an
// optional one-line hint under it, the control on the right. A row's description (`desc`) isn't printed on the row: the
// settings screen shows the hovered or focused row's in one help line at the bottom (settings-panel.ts), screen readers
// get it through aria-describedby, and the search indexes it. Rows are searchable by label, hint, description, keywords
// and their section / group (settings-search.ts).
//
//   group("Mouse", range("Sensitivity", get, set, { min: 0.1, max: 10, step: 0.01, hint: "…", desc: "…" }), toggle(…))
//
// Values are read with `get` when the control is built and written with `set` on every change (the pref store applies
// them live), so controls stay dumb: no local state beyond the DOM.
//
// The controls are the game's own (style.css "controls"): a switch is a keycap that clicks across (the document-wide
// change listener in audio/ui.ts plays it, pitched up for on and down for off), a slider has a notched thumb, ticks on
// its track, a notch at its default (double-click goes back to it) and a value bubble while dragged, and ticks under
// your hand as it moves, pitched by the value. A segmented control slides one indicator between its options.

import { arrowNav, h } from "./dom";
import { prefs } from "./settings";
import { uiSound } from "../audio/ui";

export interface RowOpts {
  /** What the row does, in a sentence or two (the help line, screen readers, search). A function is re-read each time. */
  desc?: string | (() => string);
  /** Short line shown under the label: only for something the label can't say (a unit, a key), never a restatement. */
  hint?: string;
  /** Extra search terms (not shown): the words players use for this setting. */
  keywords?: string;
  /**
   * A small "i" after the label that shows this text while hovered or focused (infoTip). For a row whose name alone
   * doesn't say what it does; most rows rely on the help line instead.
   */
  info?: string;
  /** Small live readout under the label (e.g. "26.0 cm/360°"). */
  readout?: HTMLElement;
  /**
   * The change shows in the game (FOV, crosshair, resolution, the hands): in game, holding the slider (or a swatch)
   * clears the menu away but this row, so you see the paused game behind with the change applied (peek()).
   */
  peek?: boolean;
  /** Only shown while this is true (a row that depends on another setting, e.g. a switch above it). Re-read on every pref change. */
  when?: () => boolean;
}

let uid = 0;
export const uniqueId = (p: string) => `${p}-${++uid}`;

/** A labelled settings row. `control` is any element; `forId` links the label to a form element. */
export function row(label: string, control: HTMLElement, o: RowOpts = {}, forId?: string): HTMLElement {
  const descId = uniqueId("d");
  const descFn = typeof o.desc === "function" ? o.desc : o.desc ? () => o.desc as string : null;
  const desc = descFn?.() ?? "";
  const name0 = forId ? h("label.set-name", { for: forId }, label) : h("span.set-name", null, label);
  // The tip sits beside the label, not inside it: clicking it never flips the row's switch.
  const name = o.info ? h("span.set-name-line", null, name0, infoTip(o.info, label)) : name0;
  const el = h(
    "div.set-row",
    { "data-label": label, "data-keywords": o.keywords ?? "" },
    h("div.set-label", null, name, o.hint ? h("small.set-hint", null, o.hint) : null, o.readout ?? null),
    h("div.set-control", null, control),
    desc ? h("span.sr-only", { id: descId }, desc) : null,
  );
  if (o.peek) peek(el);
  if (o.when) dependsOn(el, o.when);
  if (descFn) {
    (el as HTMLElement & { descFn?: () => string }).descFn = descFn;
    const target = forId ? control.querySelector(`#${CSS.escape(forId)}`) ?? control : control;
    if (desc && target instanceof HTMLElement) target.setAttribute("aria-describedby", descId);
  }
  return el;
}

/** Hides `row` while `when()` is false, following pref changes until the row leaves the page. */
function dependsOn(row: HTMLElement, when: () => boolean): void {
  let shown = false;
  const stop = prefs.watch(() => {
    if (row.isConnected) shown = true;
    else if (shown) return void queueMicrotask(stop);
    row.hidden = !when();
  });
}

/**
 * Hold to see the game: while the pointer holds the row's slider or a swatch in game, body.peek hides the menu except
 * this row (settings.css), and the paused game behind shows the change live. Nothing runs until a press.
 */
export function peek(row: HTMLElement): HTMLElement {
  row.classList.add("can-peek");
  const end = () => {
    document.body.classList.remove("peek");
    row.classList.remove("peek-row");
    removeEventListener("pointerup", end, true);
    removeEventListener("pointercancel", end, true);
    removeEventListener("blur", end);
  };
  row.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !document.body.classList.contains("in-game")) return;
    if (!(e.target as Element).closest('input[type="range"], .swatch')) return;
    row.classList.add("peek-row");
    document.body.classList.add("peek");
    addEventListener("pointerup", end, true);
    addEventListener("pointercancel", end, true);
    addEventListener("blur", end);
  });
  return row;
}

/**
 * A small "i" that shows `text` in a tooltip while hovered or keyboard-focused (settings.css .info-tip). Esc hides it
 * until the pointer or focus leaves. `about`: what it explains, for its accessible name.
 */
export function infoTip(text: string, about: string): HTMLElement {
  const id = uniqueId("tip");
  const tip = h("span.info-tip-text", { id, role: "tooltip" }, text);
  const btn = h("button.info-tip-btn", { type: "button", "aria-label": `About ${about}`, "aria-describedby": id }, "i");
  const wrap = h("span.info-tip", null, btn, tip);
  btn.addEventListener("click", (e) => e.preventDefault());
  btn.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || wrap.classList.contains("hushed")) return;
    wrap.classList.add("hushed");
    e.stopPropagation();
  });
  const unhush = () => wrap.classList.remove("hushed");
  wrap.addEventListener("pointerleave", unhush);
  btn.addEventListener("blur", unhush);
  return wrap;
}

/** Description text of a row (the help line; also indexed by the search). */
export function rowDesc(el: Element): string {
  const fn = (el as HTMLElement & { descFn?: () => string }).descFn;
  return fn ? fn() : "";
}

/** A titled block of rows inside a settings section. */
export function group(title: string | null, ...children: (HTMLElement | null | false | undefined)[]): HTMLElement {
  return h(
    "section.set-group",
    { "data-group": title ?? "" },
    title ? h("h4.set-group-title", null, title) : null,
    h("div.set-group-rows", null, ...children.filter((c): c is HTMLElement => !!c)),
  );
}

export interface RangeOpts extends RowOpts {
  min: number;
  max: number;
  step: number;
  /** Display multiplier for the number box (0.55 -> 55 with scale 100). Default 1. */
  scale?: number;
  /** Unit after the number box ("%", "°", "px"). */
  unit?: string;
  /** Typed values may go beyond the slider (e.g. sensitivity 15): [min, max] in stored units. */
  inputRange?: [number, number];
  /** The default (the notch on the track; double-click goes back to it). Read from the default prefs when not given. */
  def?: number;
}

const decimals = (step: number) => Math.max(0, Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)));

/** Track ticks: every step when there are few, else a round interval (1, 2, 2.5 or 5 x 10^n) giving 5 to 20 of them. */
export function rangeTicks(min: number, max: number, step: number): { every: number; from: number } | null {
  const span = max - min;
  if (!(span > 0) || !(step > 0)) return null;
  const n = Math.round(span / step);
  if (n >= 2 && n <= 20) return { every: step / span, from: 0 };
  const raw = span / 12;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const iv = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => span / v <= 20) ?? 10 * mag;
  const first = Math.ceil(min / iv - 1e-9) * iv;
  return { every: iv / span, from: (first - min) / span };
}

/** Last slider tick sound (one at a time across the page). */
let lastTick = 0;

/**
 * Slider + typed number (with unit). Arrow keys on the slider nudge by one step; the number box takes exact values.
 * Dragging shows the value over the thumb and ticks under the hand (pitched by the value; a stronger one crossing the
 * default). Double-click the slider: back to the default.
 */
export function range(label: string, get: () => number, set: (v: number) => void, o: RangeOpts): HTMLElement {
  const sid = uniqueId("r");
  const k = o.scale ?? 1;
  const dp = decimals(o.step * k);
  const [lo, hi] = o.inputRange ?? [o.min, o.max];
  const def = o.def ?? prefs.atDefaults(get);
  const frac = (v: number) => (Math.min(o.max, Math.max(o.min, v)) - o.min) / (o.max - o.min || 1);
  const slider = h("input", { type: "range", id: sid, min: String(o.min), max: String(o.max), step: String(o.step) });
  const ticks = rangeTicks(o.min, o.max, o.step);
  if (ticks) (slider.style.setProperty("--tk", String(ticks.every)), slider.style.setProperty("--tk0", String(ticks.from)));
  if (Number.isFinite(def) && def >= o.min && def <= o.max) slider.style.setProperty("--d", String(frac(def)));
  const num = h("input.num-input", { type: "number", min: String(lo * k), max: String(hi * k), step: String(o.step * k), "aria-label": `${label} value`, inputmode: "decimal" });
  const fmt = (v: number) => String(Number((v * k).toFixed(Math.max(dp, 3))));
  const bubble = h("span.range-bub", { "aria-hidden": "true" });
  const wrap = h("span.range-track", null, slider, h("span.range-bub-rail", { "aria-hidden": "true" }, bubble));
  const fill = () => wrap.style.setProperty("--p", String(frac(get())));
  const show = (force = false) => {
    const v = get();
    slider.value = String(v);
    if (force || document.activeElement !== num) num.value = fmt(v);
    bubble.textContent = `${fmt(v)}${o.unit ?? ""}`;
    fill();
  };
  // Ticks under the hand: one per 1/24 of the track at most every 45 ms, rising with the value; crossing the default
  // plays a firmer one and pops the bubble.
  let bucket = -1;
  let side = 0;
  const tick = () => {
    const p = frac(get());
    const b = Math.round(p * 24);
    const s = Math.sign(get() - def);
    const crossed = Number.isFinite(def) && side !== 0 && s !== side;
    side = s || side;
    if (b === bucket && !crossed) return;
    bucket = b;
    const now = performance.now();
    if (now - lastTick < 45 && !crossed) return;
    lastTick = now;
    if (crossed) {
      uiSound("ui_hover", 0.55, 1.4);
      bubble.classList.remove("pulse");
      void bubble.offsetWidth;
      bubble.classList.add("pulse");
    } else uiSound("ui_hover", 0.3, 0.8 + p * 0.5);
  };
  slider.addEventListener("input", () => {
    set(Number(slider.value));
    show();
    tick();
  });
  const grab = () => {
    bucket = Math.round(frac(get()) * 24);
    side = Math.sign(get() - def);
    wrap.classList.add("held");
    const end = () => (wrap.classList.remove("held"), removeEventListener("pointerup", end, true), removeEventListener("pointercancel", end, true));
    addEventListener("pointerup", end, true);
    addEventListener("pointercancel", end, true);
  };
  slider.addEventListener("pointerdown", grab);
  slider.addEventListener("keydown", () => {
    bucket = Math.round(frac(get()) * 24);
    side = Math.sign(get() - def);
  });
  slider.addEventListener("dblclick", () => {
    if (!Number.isFinite(def) || get() === def) return;
    set(def);
    show(true);
    uiSound("ui_hover", 0.55, 1.4);
    slider.dispatchEvent(new Event("change", { bubbles: true }));
  });
  num.addEventListener("change", () => {
    const v = Number(num.value) / k;
    if (num.value.trim() !== "" && isFinite(v)) set(Math.min(hi, Math.max(lo, v)));
    show(true);
  });
  num.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (num.blur(), e.preventDefault());
  });
  show();
  const r = row(label, h("div.range", null, wrap, h("span.num-wrap", null, num, o.unit ? h("span.unit", { "aria-hidden": "true" }, o.unit) : null)), o, sid);
  r.classList.add("is-range");
  return r;
}

/** On/off switch. Its position and colour are the state (no "On" / "Off" word beside it). */
export function toggle(label: string, get: () => boolean, set: (v: boolean) => void, o: RowOpts = {}): HTMLElement {
  const tid = uniqueId("t");
  const cb = h("input.switch", { type: "checkbox", id: tid, role: "switch" });
  cb.checked = get();
  cb.addEventListener("change", () => set(cb.checked));
  const r = row(label, cb, o, tid);
  r.classList.add("is-toggle");
  syncable(r, () => (cb.checked = get()));
  return r;
}

/** Compact switch tile (dense grids such as the HUD element list). */
export function check(label: string, get: () => boolean, set: (v: boolean) => void, o: RowOpts = {}): HTMLElement {
  const tid = uniqueId("c");
  const cb = h("input.switch.sm", { type: "checkbox", id: tid, role: "switch" });
  cb.checked = get();
  cb.addEventListener("change", () => set(cb.checked));
  const r = row(label, cb, o, tid);
  r.classList.add("is-toggle", "compact");
  syncable(r, () => (cb.checked = get()));
  return r;
}

/** Re-reads a switch's value from its pref (the same pref can have a switch in two places: HUD → Show on screen). */
function syncable(r: HTMLElement, sync: () => void): void {
  (r as HTMLElement & { sync?: () => void }).sync = sync;
  r.classList.add("is-syncable");
}

/** Brings every switch under `root` back in line with its pref (after a change made somewhere else). */
export function syncSwitches(root: ParentNode): void {
  for (const r of root.querySelectorAll<HTMLElement>(".is-syncable")) (r as HTMLElement & { sync?: () => void }).sync?.();
}

/** Native select (styled). Numbers round-trip as numbers. */
export function select<T extends string | number>(label: string, get: () => T, set: (v: T) => void, options: [T, string, { disabled?: boolean }?][], o: RowOpts = {}): HTMLElement {
  const sid = uniqueId("s");
  const sel = h("select.select", { id: sid }, ...options.map(([v, l, x]) => h("option", { value: String(v), disabled: !!x?.disabled }, l)));
  sel.value = String(get());
  sel.addEventListener("change", () => set((typeof options[0][0] === "number" ? Number(sel.value) : sel.value) as T));
  return row(label, sel, o, sid);
}

/**
 * The sliding indicator of a `.seg` (one element moved with transforms, not a background per button): follows the
 * button with `.on`, or hides when none is. Call `paint()` after the selection changes; it measures once per call.
 */
export function segIndicator(wrap: HTMLElement): { paint: () => void } {
  const ind = h("span.seg-ind", { "aria-hidden": "true" });
  wrap.classList.add("has-ind");
  wrap.prepend(ind);
  let placed = false;
  const paint = () => {
    const on = wrap.querySelector<HTMLElement>(":scope > button.on");
    if (!on || !wrap.isConnected || !on.offsetWidth) {
      ind.style.opacity = on ? ind.style.opacity : "0";
      if (on && !wrap.isConnected) requestAnimationFrame(() => wrap.isConnected && paint());
      return;
    }
    // (No slide on the first placement: it would fly in from the left.)
    if (!placed) ind.style.transition = "none";
    ind.style.opacity = "1";
    ind.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px) scaleX(${on.offsetWidth / 100})`;
    ind.style.height = `${on.offsetHeight}px`;
    if (!placed) (void ind.offsetWidth, (ind.style.transition = ""), (placed = true));
  };
  // Wrapped rows reflow on resize: re-place without a slide.
  const ro = new ResizeObserver(() => {
    if (!wrap.isConnected) return;
    placed = false;
    paint();
  });
  ro.observe(wrap);
  return { paint };
}

/** Segmented choice (radio group with a roving tab stop; ← / → move and select). Each option ticks a step higher. */
export function segmented<T extends string>(label: string, get: () => T, set: (v: T) => void, options: [T, string][], o: RowOpts = {}): HTMLElement {
  const wrap = h("div.seg", { role: "radiogroup", "aria-label": label });
  const paint = () => {
    const cur = get();
    const anyOn = options.some(([v]) => v === cur);
    [...wrap.querySelectorAll<HTMLButtonElement>(":scope > button")].forEach((b, i) => {
      const on = b.dataset.v === cur;
      b.setAttribute("aria-checked", String(on));
      b.classList.toggle("on", on);
      // Nothing lit (a "custom" value): the first segment keeps the tab stop.
      b.tabIndex = on || (!anyOn && i === 0) ? 0 : -1;
    });
    ind.paint();
  };
  options.forEach(([v, l], i) =>
    wrap.append(
      h("button", {
        type: "button",
        role: "radio",
        "data-v": v,
        "data-sound": "none",
        onclick: () => {
          if (get() !== v) uiSound("ui_switch", 1, 0.86 + i * 0.09);
          set(v);
          paint();
        },
      }, l),
    ),
  );
  const ind = segIndicator(wrap);
  wrap.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const items = [...wrap.querySelectorAll<HTMLButtonElement>("button")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const n = items[(i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length];
    n.focus();
    n.click();
  });
  paint();
  const r = row(label, wrap, o);
  r.classList.add("is-seg");
  (r as HTMLElement & { repaint?: () => void }).repaint = paint;
  return r;
}

export const SWATCHES = ["#4dff6a", "#00e5ff", "#ffe14d", "#ffffff", "#ff4d6d", "#ff7ad9"];

/** Preset swatches + a free colour picker. */
export function color(label: string, get: () => string, set: (v: string) => void, o: RowOpts & { swatches?: string[] } = {}): HTMLElement {
  const cid = uniqueId("c");
  const input = h("input", { type: "color", id: cid, "aria-label": `${label}: custom colour` });
  input.value = get();
  const sw = h("div.swatches", { role: "radiogroup", "aria-label": label });
  const paint = () => {
    for (const b of sw.children) {
      const on = (b as HTMLElement).dataset.c?.toLowerCase() === get().toLowerCase();
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
    }
  };
  for (const c of o.swatches ?? SWATCHES) {
    sw.append(h("button.swatch", { type: "button", role: "radio", style: `--c:${c}`, "data-c": c, "aria-label": c, onclick: () => (set(c), (input.value = c), paint()) }));
  }
  arrowNav(sw, "button");
  input.addEventListener("input", () => (set(input.value), paint()));
  paint();
  return row(label, h("div.color-row", null, sw, input), o);
}

/** A row whose control is one or more buttons. */
export function actions(label: string, buttons: HTMLElement[], o: RowOpts = {}): HTMLElement {
  return row(label, h("div.btn-row", null, ...buttons), o);
}

/** Small button (design-system `.btn`). */
export function button(label: string | Node, onclick: () => void, o: { primary?: boolean; disabled?: boolean; title?: string } = {}): HTMLButtonElement {
  return h(`button.btn.btn-sm${o.primary ? ".primary" : ""}`, { type: "button", onclick, disabled: !!o.disabled, title: o.title }, label);
}

/** A keycap (<kbd>) showing a key, e.g. in a row's hint or a read-only bind. */
export function keycap(text: string): HTMLElement {
  return h("kbd.keycap", null, text);
}
