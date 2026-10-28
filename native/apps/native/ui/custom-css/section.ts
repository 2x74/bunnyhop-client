import { h } from "../../../web/src/ui/dom";
import { registerSettingsSection } from "../../../web/src/ui/settings-registry";
import { openFile, unwatchCssFile } from "../native-files";
import type { Ui } from "../native-rows";
import { cssStatus, customCss, onCssStatus, setCssFile, setCustomCss } from "./custom-css";
import { openCssEditor, statusLine } from "./editor";

// Settings -> Custom CSS: the website's switch and editor, and a .css file the game reloads whenever it's saved.

const HUD_NOTE =
  "The game draws its own HUD: it takes your colours (--cream, --cream-2, --amber, --gain, --loss, --sync-ok) and " +
  "each element's color and opacity. Fonts, images and layout apply to the menus only.";

async function chooseFile(status: HTMLElement): Promise<void> {
  const answer = await openFile("css");
  if (answer.cancelled) return;
  if (!answer.ok) {
    status.textContent = answer.error ?? "The file couldn't be read.";
    return;
  }
  setCssFile({ name: answer.name ?? "", text: answer.text ?? "", error: "" });
}

function cssGroup(ui: Ui): HTMLElement {
  const fileName = h("small.set-readout");
  const status = h("small.set-readout", { role: "status" });
  const choose = ui.button("Choose .css file…", () => void chooseFile(status));
  const stop = ui.button("Stop using", () => {
    unwatchCssFile();
    setCssFile(null);
  });
  const use = ui.toggle("Use your CSS", () => customCss().on, (on) => setCustomCss({ on }, { now: true }), {
    readout: status,
    desc: `Your own stylesheet over the menus and the HUD. Ctrl+Shift+V switches it off from anywhere in the menus. ${HUD_NOTE}`,
    keywords: "css custom css theme skin style stylesheet font fonts colour color ui interface image gif mod",
  });
  const group = ui.group(
    "Custom CSS",
    use,
    ui.actions("Your CSS", [ui.button("Edit CSS", openCssEditor, { primary: true })], {
      desc: "Paste CSS or import it from a link. It applies as you type.",
      keywords: "css edit paste import link theme",
    }),
    ui.actions("CSS file", [choose, stop], {
      readout: fileName,
      desc: "Use a .css file instead of the pasted CSS. Edit it in any editor; the game reloads it each time you save.",
      keywords: "css file watch reload editor theme",
    }),
  );
  const paint = (): void => {
    const state = cssStatus();
    ui.syncSwitches(group);
    fileName.textContent = state.file ? state.file.name : "";
    stop.hidden = !state.file;
    status.textContent = statusLine(state).text;
  };
  const unsubscribe = onCssStatus(() => {
    if (group.isConnected || !seen) paint();
    else unsubscribe();
    seen ||= group.isConnected;
  });
  let seen = false;
  paint();
  return group;
}

/** Registers Settings → Custom CSS (call once). */
export function registerCustomCssSection(): void {
  registerSettingsSection("css", (ui) => [cssGroup(ui)], { label: "Custom CSS", icon: "pen", order: 75 });
}
