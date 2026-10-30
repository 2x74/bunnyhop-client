// The settings screen is the website's (web ui/settings-panel.ts): the same sections, rows, search, previews,
// profiles and export / import. The native client adds its own sections through the website's section registry and
// keeps the website's settings document in step with the host (prefs-bridge.ts). Rows the host can't honour are
// left out (settings-gates.ts).

// The keys overlay preview (Settings → HUD) is drawn with the HUD's own styles.
import "../../web/src/hud/hud.css";
import "./settings-native.css";
import "../../web/src/viewmodel/settings";
import "../../web/src/ui/account-settings";
import { registerAudioSettings } from "../../web/src/audio/settings-section";
import { cancelBindCapture, settingsPanel as webSettingsPanel } from "../../web/src/ui/settings-panel";
import { registerCustomCssSection } from "./custom-css/section";
import { registerDataFolderSection } from "./data-folder-panel";
import { registerDiscordSection } from "./discord-section";
import { registerMouseDiagnostics } from "./mouse-diagnostics";
import { registerMeasureSection } from "./measure-section";
import { registerPaintSection } from "./paint-section";
import { installHostHudEditor } from "./hud-editor-opener";
import { registerHudRows } from "./hud-section";
import { redrawSettings, registerNativeExtras } from "./native-extras";
import { installGlowSettings } from "./glow-settings";
import { flushSettings, onHostSettings } from "./prefs-bridge";
import { decorateNativeRows } from "./settings-decorations";
import { registerUpdatesSection } from "./update-panel";
import { registerDisplaySection } from "./window-panel";

/** Where the website keeps the section the screen last showed (settings-panel.ts LAST_SECTION). */
const LAST_SECTION = "bunnyhop:settings-tab";
/** Section ids the host and older menus open settings at, as the screen's own ids. */
const SECTION_ALIASES: Record<string, string> = { "hud-editor": "hud", transfer: "mouse", window: "display" };

let installed = false;

function install(): void {
  if (installed) return;
  installed = true;
  installGlowSettings();
  registerAudioSettings();
  registerDisplaySection();
  registerDiscordSection();
  registerDataFolderSection();
  registerUpdatesSection();
  registerCustomCssSection();
  registerPaintSection();
  registerMeasureSection();
  installHostHudEditor();
  registerHudRows();
  registerMouseDiagnostics();
  registerNativeExtras();
  decorateNativeRows();
  // A host change to what prefs show, or to what the host has, redraws the screen in place.
  onHostSettings(redrawSettings);
}

const sectionId = (id: string): string => SECTION_ALIASES[id] ?? id;

/** The settings screen; `initialSection` is where it opens. */
export function settingsPanel(initialSection?: string): HTMLElement {
  install();
  if (initialSection) sessionStorage.setItem(LAST_SECTION, sectionId(initialSection));
  const panel = webSettingsPanel();
  // The search box sits over the rail here (settings-native.css): a short placeholder fits it.
  const search = panel.querySelector<HTMLInputElement>("input.set-q");
  if (search) search.placeholder = "Search settings";
  watchClose(panel);
  return panel;
}

/** Jumps the open settings screen under `root` to section `id`. */
export function focusSettingsSection(root: HTMLElement, id: string): boolean {
  if (!/^[a-z][a-z-]*$/.test(id)) return false;
  const item = root.querySelector<HTMLButtonElement>(`.set-rail-item[data-sec="${sectionId(id)}"]`);
  if (!item) return false;
  item.click();
  return true;
}

/** Leaving the screen sends what's still waiting and ends a key capture. */
function watchClose(panel: HTMLElement): void {
  let attached = false;
  const observer = new MutationObserver(() => {
    if (panel.isConnected) attached = true;
    else if (attached) {
      observer.disconnect();
      cancelBindCapture();
      flushSettings();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
