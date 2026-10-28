import { h } from "../../../web/src/ui/dom";
import { openFile, unwatchCssFile } from "../native-files";
import { cssStatus, customCss, onCssStatus, setCssFile, setCustomCss } from "./custom-css";
import { openCssEditor, statusLine } from "./editor";

// Settings -> Custom CSS: the switch, the editor, and a .css file the game
// reloads whenever it's saved (as in the desktop app).

type Row = (name: string, control: HTMLElement, hint?: string, about?: string) => HTMLElement;
type Group = (title: string, ...rows: HTMLElement[]) => HTMLElement;

export function customCssSection(row: Row, group: Group): HTMLElement {
  const toggleOptions = { type: "checkbox", checked: customCss().on, "aria-label": "Use your CSS" };
  const toggle = h("input.switch", toggleOptions) as HTMLInputElement;
  toggle.addEventListener("change", () => setCustomCss({ on: toggle.checked }, { now: true }));
  const useRow = row("Use your CSS", toggle, "",
    "Your own stylesheet over the menus, and colours for the HUD. " +
      "Ctrl+Shift+V switches it off from anywhere in the menus.");
  useRow.classList.add("nset-row-toggle");
  useRow.addEventListener("click", (event) => {
    if (event.target !== toggle) toggle.click();
  });

  const edit = h("button.btn", { type: "button", onclick: openCssEditor }, "Edit CSS");
  const choose = h("button.btn", { type: "button" }, "Choose .css file…") as HTMLButtonElement;
  const stop = h("button.btn", { type: "button" }, "Stop using") as HTMLButtonElement;
  const fileName = h("small.nset-hint");
  const status = h("p.nset-hint.nset-transfer-status", { role: "status" });

  choose.addEventListener("click", async () => {
    choose.disabled = true;
    try {
      const answer = await openFile("css");
      if (answer.cancelled) return;
      if (!answer.ok) throw new Error(answer.error ?? "The file couldn't be read.");
      setCssFile({ name: answer.name ?? "", text: answer.text ?? "", error: "" });
    } catch (error) {
      status.textContent = (error as Error).message;
      status.dataset.tone = "bad";
    } finally {
      choose.disabled = false;
    }
  });
  stop.addEventListener("click", () => {
    unwatchCssFile();
    setCssFile(null);
  });

  const section = h("div", null,
    group("Custom CSS",
      useRow,
      row("Your CSS", h("div.nset-actions", null, edit), "",
        "Paste CSS or import it from a link. It applies as you type."),
      row("CSS file", h("div.nset-actions", null, fileName, choose, stop), "",
        "Use a .css file instead of the pasted CSS. Edit it in any editor; the game reloads it each time you save.")),
    status,
    h("p.nset-hint", null,
      "The game draws its own HUD: it takes your colours (--cream, --cream-2, --amber, --gain, --loss, --sync-ok) " +
        "and each element's color and opacity. Fonts, images and layout apply to the menus only."));

  const paint = (): void => {
    const state = cssStatus();
    toggle.checked = customCss().on;
    fileName.textContent = state.file ? state.file.name : "";
    stop.hidden = !state.file;
    const line = statusLine(state);
    status.textContent = line.text;
    status.dataset.tone = line.tone;
  };
  // The listener goes with the section once Settings is closed.
  const unsubscribe = onCssStatus(() => {
    if (section.isConnected) paint();
    else unsubscribe();
  });
  paint();
  return section;
}
