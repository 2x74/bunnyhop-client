// Hold to confirm: a button for things you can't take back (sign out, unlink, start over) instead of a native
// confirm(). Press and hold: a fill sweeps across it (a scaleX transform on a pseudo-element, ~700 ms, hold.css), and
// it acts when the fill lands, with ui_confirm. Let go early and the fill drains back; nothing happens. Enter / Space
// held down work the same. A quick tap says "Keep holding" for a moment.
//
//   holdButton("Sign out", () => void signOut(), { className: "btn-sm" })

import { h } from "./dom";
import { uiSound } from "../audio/ui";
import "./hold.css";

export interface HoldOpts {
  /** Extra classes for the button ("btn-sm", "danger", ...). */
  className?: string;
  /** How long to hold, ms (default 700). */
  ms?: number;
  title?: string;
  disabled?: boolean;
}

export function holdButton(label: string, onConfirm: () => void, o: HoldOpts = {}): HTMLButtonElement {
  const ms = o.ms ?? 700;
  const text = h("span.hold-label", null, label);
  const b = h(`button.btn.hold${o.className ? `.${o.className.split(" ").join(".")}` : ""}`, {
    type: "button",
    title: o.title,
    disabled: !!o.disabled,
    "data-sound": "none",
    "aria-label": `${label} (press and hold)`,
    style: `--hold:${ms}ms`,
  }, text) as HTMLButtonElement;
  let timer = 0;
  let started = 0;
  let hintTimer = 0;
  const start = () => {
    if (b.disabled || timer) return;
    started = performance.now();
    b.classList.add("holding");
    uiSound("ui_press");
    timer = window.setTimeout(() => {
      timer = 0;
      b.classList.remove("holding");
      b.classList.add("held");
      setTimeout(() => b.classList.remove("held"), 400);
      uiSound("ui_confirm");
      onConfirm();
    }, ms);
  };
  const cancel = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
    b.classList.remove("holding");
    if (performance.now() - started < 250) {
      text.textContent = "Keep holding";
      clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => (text.textContent = label), 1200);
    }
  };
  b.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    b.setPointerCapture(e.pointerId);
    start();
  });
  b.addEventListener("pointerup", cancel);
  b.addEventListener("pointercancel", cancel);
  b.addEventListener("lostpointercapture", cancel);
  b.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (!e.repeat) start();
  });
  b.addEventListener("keyup", (e) => {
    if (e.key === "Enter" || e.key === " ") cancel();
  });
  b.addEventListener("blur", cancel);
  // (A click on its own does nothing: the hold is the confirmation.)
  b.addEventListener("click", (e) => e.preventDefault());
  return b;
}
