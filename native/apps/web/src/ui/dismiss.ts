// Closing a dialog or panel with a press outside it ("light dismiss"), the same everywhere: the press has to start AND
// end outside the box, so a text selection dragged out of a field or a slider pulled past the edge never closes it.
// For a modal <dialog> the box is the dialog's own rectangle: a press on its backdrop targets the dialog element too,
// so `e.target === dialog` alone can't tell the backdrop from the dialog's padding. Presses on toasts (an Undo above
// an open dialog) and on anything marked [data-keep-open] don't count. Esc is each dialog's own business.
//
//   dismissOutside(dialog, () => dialog.close());                  // a modal dialog
//   const stop = dismissOutside(panel, close, { also: [button] }); // a panel: its opener isn't "outside"

export interface DismissOpts {
  /** Elements that count as inside too (the button that toggles a panel). */
  also?: (Element | null | undefined)[];
  /** Only while this says so (a hidden panel ignores presses). */
  active?: () => boolean;
}

const kept = (t: EventTarget | null) => t instanceof Element && !!t.closest("#nt-toasts, .nt-toast, .sm-menu, [data-keep-open]");

export function dismissOutside(box: HTMLElement, close: () => void, o: DismissOpts = {}): () => void {
  const outside = (e: PointerEvent) => {
    if (kept(e.target)) return false;
    const inEl = (el: Element | null | undefined) => {
      if (!el) return false;
      // A modal dialog: by its rectangle (see above). Anything else: by the DOM, then the rectangle.
      if (!(el instanceof HTMLDialogElement) && e.target instanceof Node && el.contains(e.target)) return true;
      const r = el.getBoundingClientRect();
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    };
    return !inEl(box) && !(o.also ?? []).some(inEl);
  };
  // Only the top layer listens: the last open modal dialog, or a panel when no dialog is open over it.
  const onTop = () => {
    const open = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].filter((d) => d.matches(":modal"));
    return box instanceof HTMLDialogElement ? open.at(-1) === box : !open.length;
  };
  let startedOutside = false;
  const down = (e: PointerEvent) => {
    startedOutside = e.button === 0 && (o.active?.() ?? true) && onTop() && outside(e);
  };
  const up = (e: PointerEvent) => {
    if (startedOutside && outside(e) && (o.active?.() ?? true)) close();
    startedOutside = false;
  };
  // Capture on the document: a modal dialog's backdrop and the page under a panel both reach it first.
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointerup", up, true);
  const stop = () => {
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointerup", up, true);
  };
  if (box instanceof HTMLDialogElement) box.addEventListener("close", stop, { once: true });
  return stop;
}
