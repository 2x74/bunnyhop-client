// Typing ANTIPIRACY on the menu opens a joke anti-piracy notice, in the style of the ones 1990s console
// games showed pirated copies. Nothing is checked and nothing is reported; it is a gag.
import { h } from "../../web/src/ui/dom";
import { wordmark } from "../../web/src/ui/brand";

const CODE = "ANTIPIRACY";
/** Typing stops counting as one sequence after this long between letters. */
const LETTER_GAP_MS = 1500;

/** Letters typed so far, as a suffix of CODE. */
let progress = "";
let lastLetter = 0;
let open = false;

function dialog(label: string, cls: string, ...children: HTMLElement[]): HTMLDialogElement {
  const d = h("dialog", { class: cls, "aria-label": label }, ...children) as HTMLDialogElement;
  // The menu's Escape handler ignores screens while a dialog is open; closing is deliberate here.
  d.addEventListener("cancel", (e) => e.preventDefault());
  d.addEventListener("keydown", (e) => e.stopPropagation());
  document.body.append(d);
  return d;
}

function close(d: HTMLDialogElement): void {
  d.close();
  d.remove();
  open = false;
}

function notice(): void {
  const d = dialog(
    "Anti-piracy notice",
    "antipiracy-screen",
    h("button.antipiracy-close", { "aria-label": "Close", onclick: () => close(d) }, "×"),
    h(
      "div.antipiracy-body",
      null,
      wordmark("xl"),
      h("p", null, "bunnyhop.lol will not operate when connected to a device which makes unauthorised copies."),
      h("p", null, "Please refer to test2.dll for further information."),
    ),
  );
  d.showModal();
}

function confirm(): void {
  const d = dialog(
    "Confirm",
    "antipiracy",
    h("p", null, "Do you know what you've just typed? Click no if you're unsure."),
    h(
      "div.antipiracy-row",
      null,
      h(
        "button",
        {
          onclick: () => {
            close(d);
            notice();
          },
        },
        "Yes",
      ),
      h("button", { onclick: () => close(d) }, "No"),
    ),
  );
  d.showModal();
}

/** Call once at menu start. Letters only count on the menu itself, never while typing into a field. */
export function watchForAntipiracy(): void {
  document.addEventListener("keydown", (event) => {
    if (open || event.ctrlKey || event.altKey || event.metaKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
      return;
    if (event.key.length !== 1) return;
    const letter = event.key.toUpperCase();
    const now = Date.now();
    if (now - lastLetter > LETTER_GAP_MS) progress = "";
    lastLetter = now;
    progress += letter;
    // Keep only what can still become the code, so a near miss doesn't need a pause to retry.
    while (progress && !CODE.startsWith(progress)) progress = progress.slice(1);
    if (progress !== CODE) return;
    progress = "";
    open = true;
    confirm();
  });
}
