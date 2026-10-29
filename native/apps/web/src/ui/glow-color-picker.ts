import type { HexGlowColor } from "../player/glow-config";
import { h } from "./dom";
import { hexToHsv, hsvToHex, pickerHex } from "./glow-color-model";
import "./account.css";
import "./glow-color-picker.css";
import { dismissOutside } from "./dismiss";

let nextPicker = 0;
interface PickerOptions {
  current: HexGlowColor;
  preview: (color: HexGlowColor) => void;
  apply: (color: HexGlowColor) => void;
  closed: () => void;
  /** Dialog title and intro line (defaults: the player glow's). */
  title?: string;
  intro?: string;
}
/** Draft previews never write an account preference. Escape, close and Cancel discard the draft. */
export function glowColorPicker(options: PickerOptions): HTMLDialogElement {
  const id = `glow-color-${++nextPicker}`;
  let selected = options.current;
  let hsv = hexToHsv(selected);
  const dialog = h("dialog.acct-dialog.gc-dialog", { "aria-labelledby": `${id}-title` });
  const close = () => dialog.close();
  const cursor = h("span.gc-cursor", { "aria-hidden": "true" });
  const field = h("div.gc-field", { tabindex: "0", role: "group", "aria-label": "Saturation and brightness", "aria-describedby": `${id}-field-help` }, cursor);
  const hue = h("input.gc-hue", { type: "range", min: "0", max: "360", step: "1", "aria-label": "Hue" });
  const hex = h("input.nf-input.gc-hex", { id: `${id}-hex`, type: "text", value: selected, maxlength: "7", autocomplete: "off", spellcheck: "false", "aria-describedby": `${id}-hex-help ${id}-error` });
  const error = h("span.gc-error", { id: `${id}-error`, role: "status", "aria-live": "polite" });
  const chip = h("span.gc-chip", { "aria-hidden": "true" });
  const readout = h("span.gc-readout", { "aria-live": "polite" });
  const apply = h("button.btn.primary", { type: "submit" }, "Apply color");
  const draw = (writeHex = true) => {
    dialog.style.setProperty("--gc-color", selected);
    field.style.setProperty("--gc-hue", `hsl(${hsv.h} 100% 50%)`);
    cursor.style.left = `${hsv.s * 100}%`;
    cursor.style.top = `${(1 - hsv.v) * 100}%`;
    hue.value = String(hsv.h);
    hue.setAttribute("aria-valuetext", `${Math.round(hsv.h)} degrees`);
    field.setAttribute("aria-label", `Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
    readout.textContent = selected.toUpperCase();
    if (writeHex) hex.value = selected;
  };
  const valid = (okay: boolean) => {
    apply.disabled = !okay;
    hex.setAttribute("aria-invalid", String(!okay));
    error.textContent = okay ? "" : "Enter 3 or 6 hex digits, such as #BD54FF.";
  };
  const chooseHsv = () => {
    selected = hsvToHex(hsv);
    valid(true);
    draw();
    options.preview(selected);
  };
  const choosePoint = (event: PointerEvent) => {
    const bounds = field.getBoundingClientRect();
    hsv.s = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    hsv.v = 1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    chooseHsv();
  };
  field.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    field.focus();
    field.setPointerCapture(event.pointerId);
    choosePoint(event);
  });
  field.addEventListener("pointermove", event => { if (field.hasPointerCapture(event.pointerId)) choosePoint(event); });
  field.addEventListener("pointerup", event => { if (field.hasPointerCapture(event.pointerId)) field.releasePointerCapture(event.pointerId); });
  field.addEventListener("keydown", event => {
    const step = event.shiftKey ? 0.1 : 0.01;
    if (event.key === "ArrowLeft") hsv.s = Math.max(0, hsv.s - step);
    else if (event.key === "ArrowRight") hsv.s = Math.min(1, hsv.s + step);
    else if (event.key === "ArrowUp") hsv.v = Math.min(1, hsv.v + step);
    else if (event.key === "ArrowDown") hsv.v = Math.max(0, hsv.v - step);
    else return;
    event.preventDefault();
    chooseHsv();
  });
  hue.addEventListener("input", () => { hsv.h = Number(hue.value); chooseHsv(); });
  hex.addEventListener("input", () => {
    const value = pickerHex(hex.value);
    valid(!!value);
    if (!value) return;
    selected = value;
    const next = hexToHsv(value);
    hsv = { ...next, h: next.s === 0 ? hsv.h : next.h };
    draw(false);
    options.preview(value);
  });
  hex.addEventListener("blur", () => { const value = pickerHex(hex.value); if (value) hex.value = value; });
  const form = h("form.acct-body.gc-body", { onsubmit: (event: Event) => {
    event.preventDefault();
    const value = pickerHex(hex.value);
    if (!value) { valid(false); hex.focus(); return; }
    close();
    options.apply(value);
  } },
    h("p.dim.gc-intro", null, options.intro ?? "Choose a color for your outline and aura."),
    field,
    h("p.dim.gc-field-help", { id: `${id}-field-help` }, "Arrow keys move the colour: left and right for saturation, up and down for brightness. Hold Shift for bigger steps."),
    h("label.gc-hue-label", null, h("span", null, "Hue"), hue),
    h("div.gc-color-row", null, h("div.gc-current", null, chip, readout),
      h("label.gc-hex-label", { for: `${id}-hex` }, h("span", null, "Hex color"), hex)),
    h("small.dim", { id: `${id}-hex-help` }, "Type 3 or 6 hex digits. The # is optional."),
    error,
    h("div.gc-actions", null, h("button.btn", { type: "button", onclick: close }, "Cancel"), apply),
  );
  dialog.append(h("header.acct-head", null, h("h2", { id: `${id}-title` }, options.title ?? "Glow color"), h("button.acct-close", { type: "button", "aria-label": "Close color picker", onclick: close }, "×")), form);
  dialog.addEventListener("keydown", event => event.stopPropagation());
  dismissOutside(dialog, close);
  dialog.addEventListener("close", () => { options.closed(); dialog.remove(); }, { once: true });
  // Clicking the dimmed surrounding area is another cancellation path.
  dialog.addEventListener("click", event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  draw();
  document.body.append(dialog);
  dialog.showModal();
  hex.focus();
  hex.select();
  return dialog;
}
