import "../../../web/src/ui/account.css";
import { dismissOutside } from "../../../web/src/ui/dismiss";
import { h } from "../../../web/src/ui/dom";
import { icon } from "../../../web/src/ui/icons";
import { textDialog } from "../../../web/src/ui/settings-transfer";
import { toast } from "../../../web/src/notify";
import { openExternal } from "../bridge";
import { activeCss, cssStatus, customCss, fetchCssText, onCssStatus, setCustomCss, type CssStatus } from "./custom-css";
import { MAX_CSS_CHARS } from "./rewrite";

// Settings -> Custom CSS -> Edit CSS, as on the website (custom-css/editor.ts):
// one box that applies as you type, a line saying what loaded and what didn't,
// Copy, Import link, Revert and the guide. With a watched .css file the box
// shows that file, read-only: it's edited in the player's own editor.

export const GUIDE_URL = "https://bunnyhop.lol/custom-css";

const EXAMPLE = `/* Your CSS goes here. For example: */
:root { --accent: #7fd1ff; --amber: #7fd1ff; --gain: #7fd1ff; }
#hud [data-el="speed"] { color: hotpink; }`;

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
const short = (url: string): string => (url.length > 60 ? `${url.slice(0, 57)}…` : url);

/** The status line under the editor and in Settings. */
export function statusLine(status: CssStatus): { text: string; tone: "ok" | "bad" | "" } {
  if (status.file?.error) return { text: `${status.file.name}: ${status.file.error}`, tone: "bad" };
  if (!customCss().on) return { text: "Custom CSS is switched off.", tone: "" };
  if (!status.active) return { text: "", tone: "" };
  const notes: string[] = [];
  if (status.importing) notes.push("Loading the imported theme…");
  if (status.loading) notes.push(`Loading ${plural(status.loading, "link")}…`);
  if (status.failed.length) {
    const first = status.failed.slice(0, 2).map((item) => `${short(item.url)}: ${item.why}`).join(" ");
    const more = status.failed.length > 2 ? ` And ${status.failed.length - 2} more.` : "";
    notes.push(first + more);
  }
  if (status.blocked.length) {
    notes.push(`Skipped ${status.blocked.slice(0, 2).map(short).join(", ")}: only https:// links and data: URLs load.`);
  }
  if (notes.length) return { text: notes.join(" "), tone: status.failed.length || status.blocked.length ? "bad" : "" };
  const from = status.imported ? ` from ${plural(status.imported, "imported file")}` : "";
  const text = status.links ? `Applied${from}, ${plural(status.loaded, "link")} loaded.` : `Applied${from}.`;
  return { text, tone: "ok" };
}

function dialog(onClose: () => void): HTMLDialogElement {
  const box = h("dialog.acct-dialog.css-dialog", { "aria-label": "Custom CSS" }) as HTMLDialogElement;
  // Keys typed here belong to the editor, not the menu behind it.
  box.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      box.close();
    }
  });
  dismissOutside(box, () => box.close());
  box.addEventListener("close", () => {
    onClose();
    box.remove();
  });
  return box;
}

/** Opens the editor (one at a time). */
export function openCssEditor(): void {
  document.querySelector<HTMLDialogElement>("dialog.css-dialog")?.close();
  let unsubscribe = (): void => {};
  const box = dialog(() => unsubscribe());
  const opened = customCss().css;
  const text = h("textarea.css-text", {
    spellcheck: "false",
    autocomplete: "off",
    maxlength: String(MAX_CSS_CHARS),
    placeholder: EXAMPLE,
    "aria-label": "Custom CSS",
  }) as HTMLTextAreaElement;
  const lead = h("p.dim.css-lead");
  const status = h("p.nset-transfer-status", { role: "status", "aria-live": "polite" });
  const copy = h("button.btn", { type: "button" }, icon("copy"), "Copy") as HTMLButtonElement;
  const importLink = h("button.btn", { type: "button" }, icon("import"), "Import link") as HTMLButtonElement;
  const revert = h("button.btn", { type: "button", disabled: true }, icon("undo"), "Revert") as HTMLButtonElement;
  const guide = h("button.btn", { type: "button" }, icon("help"), "Guide") as HTMLButtonElement;

  const paint = (state: CssStatus): void => {
    const watched = state.file !== null;
    text.readOnly = watched;
    importLink.hidden = watched;
    revert.hidden = watched;
    lead.textContent = watched
      ? `Using ${state.file!.name}. Save the file to update it.`
      : "Applies as you type. Images and fonts load from https:// links. " +
        "If your CSS hides this screen, Ctrl+Shift+V switches it off.";
    const line = statusLine(state);
    status.textContent = line.text;
    status.dataset.tone = line.tone;
  };
  let shownFile: string | null | undefined;
  const fill = (state: CssStatus): void => {
    // The watched file's text is shown as it arrives; pasted CSS only ever changes by typing here.
    if (state.file) text.value = activeCss();
    else if (shownFile) text.value = customCss().css;
    shownFile = state.file?.name ?? null;
    paint(state);
  };
  const edited = (): void => {
    setCustomCss({ css: text.value });
    revert.disabled = text.value === opened;
  };

  text.addEventListener("input", edited);
  // Tab indents; Shift+Tab and Esc still leave the box.
  text.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.shiftKey || text.readOnly) return;
    event.preventDefault();
    text.setRangeText("  ", text.selectionStart, text.selectionEnd, "end");
    edited();
  });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text.value);
      toast("Copied your CSS.");
    } catch {
      text.focus();
      text.select();
      toast("Couldn't reach the clipboard: the CSS is selected, copy it with Ctrl+C.");
    }
  });
  revert.addEventListener("click", () => {
    text.value = opened;
    edited();
  });
  importLink.addEventListener("click", async () => {
    const link = await textDialog({
      title: "Import CSS from a link",
      label: "Link to a .css file",
      confirm: "Import",
      maxLength: 2048,
      problem: (value) => (/^https?:\/\/\S+$/i.test(value.trim()) ? null : "Paste a link that starts with https://"),
    });
    if (!link) return;
    try {
      text.value = await fetchCssText(link.trim());
      edited();
      toast("Imported. Revert puts back what you had.");
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      status.dataset.tone = "bad";
    }
  });
  guide.addEventListener("click", () => {
    if (!openExternal(GUIDE_URL)) toast("Open bunnyhop.lol/custom-css in your browser.");
  });

  const closeOptions = { type: "button", "aria-label": "Close", onclick: () => box.close() };
  const close = h("button.acct-close", closeOptions, icon("close"));
  box.append(
    h("header.acct-head", null, h("h2", null, "Custom CSS"), close),
    h("div.acct-body", null, lead, text, status, h("div.acct-actions", null, copy, importLink, revert, guide)),
  );
  document.body.append(box);
  text.value = opened;
  fill(cssStatus());
  unsubscribe = onCssStatus(fill);
  box.showModal();
  text.focus({ preventScroll: true });
}
