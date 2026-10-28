// Feedback the admin gives when something happens (research/ADMIN-DESIGN.md, "v0.0.10 iteration"): toasts, numbers
// that roll to a new value, a button that shows it is working and then that it worked, and a press state that shows
// even on a fast tap. Idle UI stays still; every bit of motion here answers an action or a change in the data, and
// prefers-reduced-motion shows the end state (admin.css).

import { glyph } from "./glyphs";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------------------------------------
// Toasts: an inverse plate, bottom right (a phone: bottom, full width). A repeat of the same words bumps the one on
// screen with a ×N instead of stacking another (tixy's merge-by-key). Reading time grows with the text; the timer
// pauses while the pointer is on the toast or the tab is hidden, so nothing is missed. An optional action (Undo).

interface Live {
  el: HTMLElement;
  count: number;
  left: number;
  timer: number;
  started: number;
}
const live = new Map<string, Live>();

const readMs = (text: string, bad: boolean) => Math.min(8000, Math.max(bad ? 6000 : 2600, 2200 + Math.max(0, text.length - 12) * 55));

function host(): HTMLElement {
  let h = document.getElementById("toasts");
  if (!h) {
    h = document.createElement("div");
    h.id = "toasts";
    h.className = "toasts";
    h.setAttribute("aria-live", "polite");
    document.body.append(h);
  }
  return h;
}

function leave(key: string): void {
  const t = live.get(key);
  if (!t) return;
  live.delete(key);
  clearTimeout(t.timer);
  t.el.classList.add("out");
  const gone = () => t.el.remove();
  t.el.addEventListener("animationend", gone, { once: true });
  setTimeout(gone, 300);
}

function arm(key: string): void {
  const t = live.get(key);
  if (!t) return;
  clearTimeout(t.timer);
  t.started = Date.now();
  t.timer = window.setTimeout(() => leave(key), t.left);
}

function pause(key: string): void {
  const t = live.get(key);
  if (!t) return;
  clearTimeout(t.timer);
  t.left = Math.max(1200, t.left - (Date.now() - t.started));
}

if (typeof document !== "undefined")
  document.addEventListener("visibilitychange", () => {
    for (const key of live.keys()) (document.hidden ? pause : arm)(key);
  });

export interface ToastAction {
  label: string;
  run: () => void | Promise<unknown>;
  /** How long the toast stays (ms) whatever its length: an Undo holds 10 s. */
  hold?: number;
}

export function toast(text: string, bad = false, action?: ToastAction): void {
  const key = `${bad ? "!" : ""}${text}`;
  const had = live.get(key);
  if (had) {
    had.count++;
    const n = had.el.querySelector(".toast-n") as HTMLElement;
    n.textContent = `×${had.count}`;
    n.hidden = false;
    had.el.classList.remove("bump");
    void had.el.offsetWidth; // restart the bump
    had.el.classList.add("bump");
    had.left = readMs(text, bad);
    arm(key);
    return;
  }
  const el = document.createElement("div");
  el.className = `toast${bad ? " bad" : ""}`;
  el.setAttribute("role", bad ? "alert" : "status");
  const words = document.createElement("span");
  words.className = "toast-text";
  words.textContent = text;
  const n = document.createElement("span");
  n.className = "toast-n";
  n.hidden = true;
  el.append(glyph(bad ? "alert" : "check"), words, n);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "toast-act";
    b.textContent = action.label;
    b.onclick = () => {
      leave(key);
      void action.run();
    };
    el.append(b);
  }
  host().append(el);
  const t: Live = { el, count: 1, left: action?.hold ?? readMs(text, bad) + (action ? 2500 : 0), timer: 0, started: Date.now() };
  if (action?.hold) el.style.setProperty("--hold", `${action.hold}ms`), el.classList.add("held");
  live.set(key, t);
  el.addEventListener("pointerenter", () => pause(key));
  el.addEventListener("pointerleave", () => arm(key));
  if (!document.hidden) arm(key);
}

// ---------------------------------------------------------------------------------------------
// Odometer: a number whose digits roll to the new value (each digit a 0-9 column moved by transform), so a change in
// the data reads as motion in the one place that changed. The real value is the element's accessible name.

const fmtInt = (v: number) => v.toLocaleString();

function digitCell(d: number): HTMLElement {
  const cell = document.createElement("span");
  cell.className = "odo-d";
  cell.style.setProperty("--d", String(d));
  const col = document.createElement("span");
  col.className = "odo-col";
  col.setAttribute("aria-hidden", "true");
  for (let i = 0; i <= 9; i++) {
    const s = document.createElement("span");
    s.textContent = String(i);
    col.append(s);
  }
  cell.append(col);
  return cell;
}

/** A rolling number. `fmt` turns the value into the text shown (digits roll; anything else is static). */
export function odometer(value: number, fmt: (v: number) => string = fmtInt): HTMLElement {
  const el = document.createElement("span");
  el.className = "odo";
  setOdometer(el, value, fmt, false);
  return el;
}

/** Moves an odometer to `value`; digits roll unless `animate` is false or motion is reduced. Returns whether it changed. */
export function setOdometer(el: HTMLElement, value: number, fmt: (v: number) => string = fmtInt, animate = true): boolean {
  const text = fmt(value);
  if (el.dataset.text === text) return false;
  const before = el.dataset.text;
  el.dataset.text = text;
  el.dataset.v = String(value);
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", text);
  const chars = [...text];
  const cells = [...el.children] as HTMLElement[];
  const roll = animate && before !== undefined && !reduced();
  if (cells.length === chars.length && cells.every((c, i) => c.classList.contains("odo-d") === /\d/.test(chars[i]))) {
    chars.forEach((ch, i) => (/\d/.test(ch) ? cells[i].style.setProperty("--d", ch) : (cells[i].textContent = ch)));
  } else {
    // A different shape (a digit more or less): rebuild; new digits roll up from where the old ones were (right-aligned).
    const old = [...(before ?? "")];
    const fresh = chars.map((ch, i) => {
      if (!/\d/.test(ch)) {
        const s = document.createElement("span");
        s.className = "odo-s";
        s.textContent = ch;
        return s;
      }
      const prev = old[old.length - (chars.length - i)];
      return digitCell(roll && prev && /\d/.test(prev) ? Number(prev) : roll ? 0 : Number(ch));
    });
    el.replaceChildren(...fresh);
    if (roll) {
      void el.offsetWidth;
      fresh.forEach((cell, i) => cell.classList.contains("odo-d") && cell.style.setProperty("--d", chars[i]));
    }
  }
  if (roll) {
    el.classList.remove("odo-bump");
    void el.offsetWidth;
    el.classList.add("odo-bump");
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Busy and done: the button that started a request shows a spinner while it runs, then a check for a moment (or
// nothing, when it failed: the toast says why). A second press while busy does nothing.

const TRIGGERS = "button, .btn";

/** The control the current action came from: the focused button (a dialog hands focus back to its opener). */
export function triggerOf(el: Element | null = document.activeElement): HTMLElement | null {
  const b = el?.closest?.(TRIGGERS) as HTMLElement | null;
  return b && !b.closest("dialog, .palette, .toasts") ? b : null;
}

export async function busy<T>(btn: HTMLElement | null, work: Promise<T>): Promise<T> {
  if (!btn || !btn.isConnected) return work;
  btn.classList.remove("is-done");
  btn.classList.add("is-busy");
  btn.setAttribute("aria-busy", "true");
  try {
    const r = await work;
    if (r && btn.isConnected) {
      btn.classList.add("is-done");
      setTimeout(() => btn.classList.remove("is-done"), 900);
    }
    return r;
  } finally {
    btn.classList.remove("is-busy");
    btn.removeAttribute("aria-busy");
  }
}

// ---------------------------------------------------------------------------------------------
// Press: `:active` ends before a transition can show on a quick tap, so the press starts on pointerdown and holds for
// at least 110 ms (admin.css .pressed: scale .97 on buttons, a deeper wash on rows).

const PRESSABLE = "button:not(:disabled), .btn, a.fig, tr.go, .nav-link, .pal-item, .room-row";

export function installPress(): void {
  document.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const el = (e.target as Element).closest?.(PRESSABLE) as HTMLElement | null;
    if (!el) return;
    const t0 = performance.now();
    el.classList.add("pressed");
    const up = () => {
      setTimeout(() => el.classList.remove("pressed"), Math.max(0, 110 - (performance.now() - t0)));
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  });
}

// ---------------------------------------------------------------------------------------------
// The hop arc: the logo's three rising hops drawn as a dotted trail, dot by dot, then the white landing dot pops. The
// panel's one recurring mark: the loader while a view loads (it repeats until the view arrives) and the calm Queue
// (once, when the last item clears). Transform / stroke-dashoffset only; reduced motion shows the finished arc.

const ARC = "M8 47 Q14.5 33 21 47 Q29 25 37 47 Q46.5 15 56 47";
let arcSeq = 0;

export function hopArc(o: { loop?: boolean; size?: number; cls?: string } = {}): SVGSVGElement {
  const id = `arc-m${++arcSeq}`;
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg class="hop-arc${o.loop ? " loop" : ""}${o.cls ? ` ${o.cls}` : ""}" viewBox="0 0 64 56" width="${o.size ?? 64}" height="${Math.round((o.size ?? 64) * 0.875)}" aria-hidden="true"><defs><mask id="${id}" maskUnits="userSpaceOnUse"><path class="arc-reveal" d="${ARC}" pathLength="100" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/></mask></defs><path class="arc-trail" d="${ARC}" pathLength="100" fill="none" mask="url(#${id})"/><circle class="arc-dot" cx="56" cy="47" r="4.5"/></svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

// ---------------------------------------------------------------------------------------------
// Verdict stamps: when a case, ticket or flag resolves, its verdict word lands over the row in its colour (scale 1.15
// to 1, 140 ms), holds, then the row folds away (240 ms). Resolves when the row is gone (or at once with reduced motion).

export type StampKind = "ink" | "bad" | "warn" | "ok";

export function stamp(row: HTMLElement, word: string, kind: StampKind = "ink", remove = true): Promise<void> {
  const el = document.createElement("span");
  el.className = `stamp ${kind}`;
  el.textContent = word;
  const host = row.tagName === "TR" ? (row.lastElementChild as HTMLElement | null) ?? row : row;
  host.classList.add("stamp-host");
  host.append(el);
  row.classList.add("stamped");
  if (!remove) return Promise.resolve();
  const quiet = reduced();
  return new Promise((done) => {
    setTimeout(
      () => {
        const hgt = row.getBoundingClientRect().height;
        if (quiet || row.tagName === "TR") {
          row.classList.add("leaving");
          setTimeout(() => (row.remove(), done()), quiet ? 0 : 240);
          return;
        }
        row.style.overflow = "hidden";
        const a = row.animate([{ height: `${hgt}px`, opacity: 1 }, { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px" }], { duration: 240, easing: "cubic-bezier(0.55, 0, 0.75, 0.3)" });
        a.onfinish = () => (row.remove(), done());
      },
      quiet ? 0 : 440,
    );
  });
}
