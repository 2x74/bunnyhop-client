// The landing dot: the logo's white dot marks "you are here" in a list and hops between items on a parabola (AIRTIME).
// Two nested elements make the arc: the outer one travels along the list linearly, the inner one lifts off the list and
// comes back (ease-out up, ease-in down), and the dot squashes as it lands. Transforms only, out of game.
// Reduced motion / body.potato: a plain cross-fade to the new spot.

export interface HopOptions {
  /** "y": a vertical list, the dot sits left of the items and arcs out to the left. "x": a row of tabs, the dot sits
   * above the items and arcs upward. */
  axis?: "x" | "y";
  /** Gap between the dot and the item edge (px). */
  inset?: number;
  /** Where the dot starts (default: the first item). */
  rest?: () => HTMLElement | null;
  /** Which side of the items the dot sits on: "start" (left of a column, above a row) or "end" (under a row of tabs,
   * riding the selected tab's bar). */
  side?: "start" | "end";
  /** Follow the selected item (matching this selector, e.g. ".on") instead of hover and focus: tabs. */
  selected?: string;
}

const D = 220; // --t-hop
const quiet = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.body.classList.contains("potato");

/** Puts a hopping dot on `list` that follows hover and focus over the items matching `selector`. */
export function hopIndicator(list: HTMLElement, selector: string, o: HopOptions = {}): HTMLElement {
  const axis = o.axis ?? "y";
  const inset = o.inset ?? 10;
  const outer = document.createElement("div");
  outer.className = `hop-ind hop-${axis}`;
  outer.setAttribute("aria-hidden", "true");
  outer.innerHTML = `<div class="hop-lift"><div class="hop-dot"></div></div>`;
  const lift = outer.firstElementChild as HTMLElement;
  const dot = lift.firstElementChild as HTMLElement;
  list.append(outer);
  let cur: HTMLElement | null = null;
  let at = 0;

  const items = () => [...list.querySelectorAll<HTMLElement>(selector)].filter((el) => !el.hidden && el.offsetParent);
  // Position along the list axis: the item's centre, relative to the list (offset* are relative to the list, which is the
  // offsetParent: .hop-host sets position: relative).
  const posOf = (el: HTMLElement) => (axis === "y" ? el.offsetTop + el.offsetHeight / 2 : el.offsetLeft + el.offsetWidth / 2);
  // Across the list: just outside the items' start edge (left of a column, above a row).
  let edge = 0;
  const edgeOf = (el: HTMLElement) =>
    o.side === "end" ? (axis === "y" ? el.offsetLeft + el.offsetWidth : el.offsetTop + el.offsetHeight) - inset : (axis === "y" ? el.offsetLeft : el.offsetTop) - inset;
  const place = (p: number) => (axis === "y" ? `translate(${edge}px, ${p}px)` : `translate(${p}px, ${edge}px)`);

  function go(el: HTMLElement | null, instant = false): void {
    if (!el || el === cur || !list.isConnected) return;
    const to = posOf(el);
    const from = at;
    if (cur === null) edge = edgeOf(el);
    const first = cur === null;
    cur = el;
    at = to;
    outer.classList.add("on");
    if (first || instant) {
      outer.style.transform = place(to);
      return;
    }
    if (quiet()) {
      outer.style.transform = place(to);
      outer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      return;
    }
    // Longer hops go higher, like the logo's arcs (clamped so a jump across the whole menu stays small).
    const height = Math.min(22, 6 + Math.abs(to - from) * 0.12);
    const up = axis === "y" ? `translateX(${-height}px)` : `translateY(${-height}px)`;
    outer.style.transform = place(to);
    outer.animate([{ transform: place(from) }, { transform: place(to) }], { duration: D, easing: "linear" });
    lift.animate(
      [
        { transform: "none", easing: "cubic-bezier(.33,1,.68,1)" },
        { transform: up, offset: 0.5, easing: "cubic-bezier(.32,0,.67,0)" },
        { transform: "none" },
      ],
      { duration: D },
    );
    // Stretch on take-off, squash on touch-down.
    const sq = axis === "y" ? "scale(1.35, 0.7)" : "scale(0.7, 1.35)";
    const st = axis === "y" ? "scale(0.85, 1.2)" : "scale(1.2, 0.85)";
    dot.animate(
      [{ transform: "none" }, { transform: st, offset: 0.2 }, { transform: "none", offset: 0.82 }, { transform: sq, offset: 0.9 }, { transform: "none" }],
      { duration: D + 110 },
    );
  }

  if (o.selected) {
    const sel = `${selector}${o.selected}`;
    new MutationObserver(() => go(list.querySelector<HTMLElement>(sel))).observe(list, { subtree: true, attributes: true, attributeFilter: ["class"] });
    requestAnimationFrame(() => go(list.querySelector<HTMLElement>(sel) ?? items()[0] ?? null, true));
    return finish();
  }
  const target = (e: Event) => (e.target as HTMLElement | null)?.closest<HTMLElement>(selector) ?? null;
  list.addEventListener("pointerover", (e) => {
    const el = target(e);
    if (el && list.contains(el)) go(el);
  });
  list.addEventListener("focusin", (e) => go(target(e)));
  list.addEventListener("pointerleave", () => {
    // Back to the focused item for keyboard users; otherwise the dot stays where it landed.
    const f = document.activeElement as HTMLElement | null;
    if (f && f !== document.body && list.contains(f)) go(f.closest<HTMLElement>(selector));
  });
  // First placement once laid out.
  requestAnimationFrame(() => go(o.rest?.() ?? items()[0] ?? null, true));
  return finish();

  /** Re-place (no hop) when the list resizes. */
  function finish(): HTMLElement {
    new ResizeObserver(() => {
    if (cur?.isConnected) {
      at = posOf(cur);
      edge = edgeOf(cur);
      outer.style.transform = place(at);
    }
    }).observe(list);
    return outer;
  }
}
