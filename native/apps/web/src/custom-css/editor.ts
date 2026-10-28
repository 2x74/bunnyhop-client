// The custom CSS editor (Settings -> Custom CSS -> Edit CSS): one text box that applies as you type, a status line
// (what loaded, what didn't), Import from a link, Copy and Revert. With the desktop app's file in use it shows that file
// read-only: it's edited in the player's own editor.

import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { modal, toast } from "../ui/account-panel";
import { textDialog } from "../ui/settings-transfer";
import { activeCss, cssStatus, customCss, fetchCssText, onCssStatus, setCustomCss, type CssStatus } from "./index";
import { MAX_CSS_CHARS } from "./rewrite";
import "../ui/settings.css";
import "./custom-css.css";

const EXAMPLE = `/* Your CSS goes here. For example: */
:root { --hud-font: "Comic Sans MS"; --accent: #7fd1ff; }
#hud [data-el="speed"] { color: hotpink; }
#custom-art::after {
  content: ""; position: absolute; right: 0; bottom: 0; width: 16vw; height: 28vh;
  background: url(https://i.imgur.com/your-image.gif) bottom right / contain no-repeat;
}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (url: string) => (url.length > 60 ? `${url.slice(0, 57)}…` : url);

function statusLine(s: CssStatus): { text: string; tone: "ok" | "bad" | "" } {
  if (s.safeMode) return { text: "Off for this visit: the address has ?nocss.", tone: "bad" };
  if (!customCss().on) return { text: "Custom CSS is switched off in Settings.", tone: "" };
  if (!s.active) return { text: "", tone: "" };
  const notes: string[] = [];
  if (s.loading) notes.push(`Loading ${plural(s.loading, "link")}…`);
  if (s.failed.length) notes.push(`${s.failed.slice(0, 2).map((f) => `${short(f.url)}: ${f.why}`).join(" ")}${s.failed.length > 2 ? ` And ${s.failed.length - 2} more.` : ""}`);
  if (s.blocked.length) notes.push(`Skipped ${s.blocked.slice(0, 2).map(short).join(", ")}: only https:// links and data: URLs load.`);
  if (s.importing) notes.unshift("Loading the imported theme…");
  if (notes.length) return { text: notes.join(" "), tone: s.failed.length || s.blocked.length ? "bad" : "" };
  const from = s.imported ? ` from ${plural(s.imported, "imported file")}` : "";
  return { text: s.links ? `Applied${from}, ${plural(s.loaded, "link")} loaded.` : `Applied${from}.`, tone: "ok" };
}

/** Opens the editor (one at a time). */
export function openCssEditor(): void {
  document.querySelector<HTMLDialogElement>("dialog.css-dialog")?.close();
  let unsubscribe = () => {};
  const d = modal("acct-dialog css-dialog", "Custom CSS", () => unsubscribe());
  const opened = customCss().css;
  const text = h("textarea.xfer-text.css-text", {
    spellcheck: "false",
    autocomplete: "off",
    autocorrect: "off",
    autocapitalize: "off",
    maxlength: String(MAX_CSS_CHARS),
    placeholder: EXAMPLE,
    "aria-label": "Custom CSS",
  }) as HTMLTextAreaElement;
  const lead = h("p.xfer-lead.dim");
  const status = h("div.xfer-status", { role: "status", "aria-live": "polite" });
  const copy = h("button.btn", { type: "button" }, icon("copy"), "Copy");
  const importBtn = h("button.btn", { type: "button" }, icon("import"), "Import link");
  const revert = h("button.btn", { type: "button", disabled: true }, icon("undo"), "Revert");
  const guide = h("a.btn", { href: "https://bunnyhop.lol/custom-css", target: "_blank", rel: "noopener" }, icon("help"), "Guide");

  const paint = (s: CssStatus) => {
    const desktop = s.desktop !== null;
    text.readOnly = desktop;
    importBtn.hidden = revert.hidden = desktop;
    lead.textContent = desktop
      ? `Using ${s.desktop} from the desktop app. Save the file to update it.`
      : "Applies as you type. Images and fonts load from https:// links. If your CSS hides this screen, Ctrl+Shift+V switches it off.";
    const line = statusLine(s);
    status.textContent = line.text;
    status.dataset.tone = line.tone;
  };
  let shownDesktop: string | null | undefined;
  const fill = (s: CssStatus) => {
    // The desktop file's text is shown as it arrives; pasted CSS is only ever what's typed here.
    if (s.desktop !== null) text.value = activeCss();
    else if (shownDesktop) text.value = customCss().css;
    shownDesktop = s.desktop;
    paint(s);
  };
  const edited = () => {
    setCustomCss({ css: text.value });
    revert.disabled = text.value === opened;
  };
  text.addEventListener("input", edited);
  // Tab indents (Shift+Tab and Esc still leave the box).
  text.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.shiftKey || text.readOnly) return;
    e.preventDefault();
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
  importBtn.addEventListener("click", async () => {
    const link = await textDialog({
      title: "Import CSS from a link",
      label: "Link to a .css file",
      confirm: "Import",
      maxLength: 2048,
      problem: (t) => (/^https?:\/\/\S+$/i.test(t.trim()) ? null : "Paste a link that starts with https://"),
    });
    if (!link) return;
    try {
      text.value = await fetchCssText(link.trim());
      edited();
      toast("Imported. Revert puts back what you had.");
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : String(e);
      status.dataset.tone = "bad";
    }
  });

  d.append(
    h("header.acct-head", null, h("h2", null, "Custom CSS"), h("button.acct-close", { type: "button", "aria-label": "Close", onclick: () => d.close() }, icon("close"))),
    h("div.acct-body.xfer-body", null, lead, text, status, h("div.acct-actions", null, copy, importBtn, revert, guide)),
  );
  text.value = opened;
  fill(cssStatus());
  unsubscribe = onCssStatus(fill);
  d.showModal();
  text.focus({ preventScroll: true });
}
