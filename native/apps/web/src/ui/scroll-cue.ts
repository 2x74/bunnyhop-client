// A quiet cue that a scroller has more: while content is hidden past an edge, the element carries .more-below (a
// vertical scroller) or .more-left / .more-right (a horizontal one), and style.css fades that edge. No arrows, no
// scrollbars forced on: the fade goes when the end is reached.

/** The edges with content hidden past them. */
export function hiddenEdges(scroll: number, size: number, full: number, slack = 4): { before: boolean; after: boolean } {
  return { before: scroll > slack, after: scroll + size < full - slack };
}

/** Keeps `el`'s cue classes in step with its scroll position, its size and its content. */
export function scrollCue(el: HTMLElement, axis: "y" | "x" = "y"): void {
  el.classList.add(axis === "y" ? "scroll-cue" : "scroll-cue-x");
  const sync = () => {
    if (axis === "y") el.classList.toggle("more-below", hiddenEdges(el.scrollTop, el.clientHeight, el.scrollHeight).after);
    else {
      const e = hiddenEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
      el.classList.toggle("more-left", e.before);
      el.classList.toggle("more-right", e.after);
    }
  };
  const later = () => requestAnimationFrame(sync);
  el.addEventListener("scroll", sync, { passive: true });
  // Its own size (a window resize, a column that reflows) and what's in it (a section that loads in, tabs redrawn).
  new ResizeObserver(later).observe(el);
  new MutationObserver(later).observe(el, { childList: true, subtree: true });
  later();
}
