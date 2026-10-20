// Lists land row by row (AIRTIME "drop"): the first rows of a freshly shown list rise into place 14 ms apart (CSS
// .land-row in style.css, transform/opacity only; off for body.potato and reduced motion). Only for a list's first
// paint, never on a re-filter or a page that's already showing.

const CAP = 12;

/** Marks `rows` (in order) to land; returns them for chaining. */
export function landRows<T extends Element>(rows: Iterable<T>): T[] {
  const out = [...rows];
  out.forEach((r, i) => {
    if (!(r instanceof HTMLElement)) return;
    r.classList.add("land-row");
    r.style.setProperty("--i", String(Math.min(i, CAP)));
    // Clean up after the animation so later hover/selection transforms aren't fighting a finished animation fill.
    const done = (e: AnimationEvent) => {
      if (e.target !== r) return;
      r.classList.remove("land-row");
      r.removeEventListener("animationend", done);
    };
    r.addEventListener("animationend", done);
  });
  return out;
}
