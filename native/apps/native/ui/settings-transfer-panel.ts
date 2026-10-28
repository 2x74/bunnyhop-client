import { api } from "../../web/src/api";
import { h } from "../../web/src/ui/dom";
import { settingsFilename } from "../../web/src/ui/settings-io";
import { state, type NativeSettings } from "./bridge";
import { openFile, saveFile } from "./native-files";
import { exportSettings, importSettings, readSettingsText } from "./settings-transfer";

// Settings -> Import / export. As on the website, a loaded file only fills the
// box; Apply is the one press that changes settings, and the result says what
// was and wasn't imported.

type Row = (name: string, control: HTMLElement, hint?: string, about?: string) => HTMLElement;
type Group = (title: string, ...rows: HTMLElement[]) => HTMLElement;

export interface TransferPanelParts {
  row: Row;
  group: Group;
  presets: HTMLElement;
  save: (patch: Partial<NativeSettings>) => void;
}

/** The settings document saved with the player's account on the website, as text for the box. */
export async function accountSettingsText(): Promise<{ text: string; note: string }> {
  const user = await api.me();
  if (!user || user.provider === "guest") throw new Error("Sign in to load the settings saved with your account.");
  const saved = await api.savedSettings();
  if (!saved.doc) {
    const hint = "Turn on \"Save settings with your account\" on the website.";
    throw new Error(`Your account has no saved settings yet. ${hint}`);
  }
  const when = saved.updatedAt ? ` (saved ${new Date(saved.updatedAt).toLocaleDateString()})` : "";
  return { text: JSON.stringify(saved.doc, null, 2), note: `Loaded the settings saved with your account${when}.` };
}

/** What Apply reports for a successful import. */
export function importSummary(applied: number, unsupported: string[]): string {
  const count = `${applied} ${applied === 1 ? "setting" : "settings"}`;
  if (!unsupported.length) return `Imported ${count}.`;
  return `Imported ${count}. Not imported: ${unsupported.join(", ")}.`;
}

export function transferPanel(parts: TransferPanelParts): HTMLElement {
  const { row, group } = parts;
  const box = h("textarea.nset-transfer", {
    rows: 8,
    spellcheck: false,
    "aria-label": "Settings code or JSON",
    placeholder: "Paste a settings code from the website (bhs1.…) or settings JSON, or load a file",
  }) as HTMLTextAreaElement;
  const status = h("p.nset-hint.nset-transfer-status", { role: "status" });
  const say = (text: string, tone: "ok" | "bad" | "" = ""): void => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  const apply = h("button.btn", { type: "button" }, "Apply") as HTMLButtonElement;
  apply.addEventListener("click", async () => {
    try {
      const result = importSettings(await readSettingsText(box.value));
      const applied = Object.keys(result.patch).length;
      if (!applied) throw new Error("No supported settings found.");
      parts.save(result.patch);
      say(importSummary(applied, result.unsupported), "ok");
    } catch (error) {
      say((error as Error).message, "bad");
    }
  });

  const load = h("button.btn", { type: "button" }, "Load .json file…") as HTMLButtonElement;
  load.addEventListener("click", async () => {
    load.disabled = true;
    try {
      const answer = await openFile("settings");
      if (answer.cancelled) return;
      if (!answer.ok) throw new Error(answer.error ?? "The file couldn't be read.");
      box.value = answer.text ?? "";
      say(`Loaded ${answer.name}. Press Apply to use it.`);
      apply.focus();
    } catch (error) {
      say((error as Error).message, "bad");
    } finally {
      load.disabled = false;
    }
  });

  const saveButton = h("button.btn", { type: "button" }, "Save .json file…") as HTMLButtonElement;
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    try {
      const answer = await saveFile("settings", exportSettings(state.settings), settingsFilename());
      if (answer.cancelled) return;
      if (!answer.ok) throw new Error(answer.error ?? "The file couldn't be saved.");
      say(`Saved ${answer.name}.`, "ok");
    } catch (error) {
      say((error as Error).message, "bad");
    } finally {
      saveButton.disabled = false;
    }
  });

  const account = h("button.btn", { type: "button" }, "Load from account") as HTMLButtonElement;
  account.addEventListener("click", async () => {
    account.disabled = true;
    try {
      const loaded = await accountSettingsText();
      box.value = loaded.text;
      say(`${loaded.note} Press Apply to use them.`);
      apply.focus();
    } catch (error) {
      say((error as Error).message, "bad");
    } finally {
      account.disabled = false;
    }
  });

  const copy = h("button.btn", { type: "button" }, "Show JSON") as HTMLButtonElement;
  copy.addEventListener("click", () => {
    box.value = exportSettings(state.settings);
    box.focus();
    box.select();
    say("Your settings are selected. Copy them to share or keep a backup.");
  });

  return h("div", null,
    group("Named presets", row("Settings presets", parts.presets, "Save setups on this device")),
    group("Import and export",
      row("File", h("div.nset-actions", null, load, saveButton), "",
        "Load a settings file saved here or on the website (.json), or a text file with a settings code. " +
          "Save writes yours to a .json file."),
      row("Account", h("div.nset-actions", null, account), "",
        "Load the settings saved with your account on the website. Nothing is uploaded from here."),
      row("Code or JSON", h("div.nset-actions", null, apply, copy), "",
        "Paste a website settings code (bhs1.…) or settings JSON in the box, then Apply.")),
    box, status);
}
