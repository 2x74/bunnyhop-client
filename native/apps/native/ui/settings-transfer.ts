// Settings → Export / Import is the website's dialog (web ui/settings-transfer.ts): a bhs1. code or a .json file in
// the website's format, so codes and files go both ways between the website and the desktop client. The menu can't
// download or pick files itself, so its "Save .json file" and "Choose file…" go through the host's file dialogs.
//
// Files the desktop client saved before it used the website's format ("bunnyhop-native-settings") still import: they
// are read as host settings and turned into a website settings document on the way in.

import { buildSettingsDoc, stringifySettings } from "../../web/src/ui/settings-io";
import { prefs, type Prefs } from "../../web/src/ui/settings";
import { VERSION } from "../../web/src/version";
import { settingsPatch } from "./bridge";
import { openFile, saveFile } from "./native-files";
import { hostSettings, pullHost, type HostSettings } from "./prefs-bridge";
import { migrateTurnSpeed } from "./turn-speed";

/** The format of settings files the desktop client wrote before. */
export const OLD_NATIVE_FORMAT = "bunnyhop-native-settings";

/** Prefs as `base`, with the native settings in `settings` applied (an old native file or preset). */
export function prefsFromNative(settings: Record<string, unknown>, base: Prefs = prefs.get()): Prefs {
  const next = JSON.parse(JSON.stringify(base)) as Prefs;
  const current = hostSettings();
  const patch = settingsPatch(migrateTurnSpeed(settings));
  const host = { ...current, ...patch, binds: { ...current.binds, ...patch.binds } } as HostSettings;
  pullHost(next, host);
  return next;
}

/** An old native settings file as the website's settings file, or the text unchanged. */
export function websiteSettingsText(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const file = parsed as { format?: unknown; settings?: unknown } | null;
  if (!file || file.format !== OLD_NATIVE_FORMAT || !file.settings || typeof file.settings !== "object") return text;
  const doc = buildSettingsDoc(prefsFromNative(file.settings as Record<string, unknown>), { app: VERSION });
  return stringifySettings(doc);
}

/** The export / import dialog's status line. */
function say(dialog: Element | null, text: string, tone: "ok" | "bad" | ""): void {
  const status = dialog?.querySelector<HTMLElement>(".xfer-status");
  if (!status) return;
  status.textContent = text;
  status.dataset.tone = tone;
}

async function saveThroughHost(link: HTMLAnchorElement): Promise<void> {
  const dialog = link.closest(".xfer-dialog");
  const text = await (await fetch(link.href)).text();
  const answer = await saveFile("settings", text, link.download);
  if (answer.cancelled) say(dialog, "", "");
  else if (!answer.ok) say(dialog, answer.error ?? "The file couldn't be saved.", "bad");
  else say(dialog, `Saved ${answer.name ?? link.download}.`, "ok");
}

async function openThroughHost(input: HTMLInputElement): Promise<void> {
  const answer = await openFile("settings");
  if (answer.cancelled) return;
  if (!answer.ok) return say(input.closest(".xfer-dialog"), answer.error ?? "That file couldn't be read.", "bad");
  const name = answer.name ?? "settings.json";
  const files = new DataTransfer();
  files.items.add(new File([websiteSettingsText(answer.text ?? "")], name, { type: "application/json" }));
  input.files = files.files;
  input.dispatchEvent(new Event("change"));
}

function onClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest(".xfer-dialog")) return;
  if (target instanceof HTMLAnchorElement && target.download) {
    event.preventDefault();
    void saveThroughHost(target);
  } else if (target instanceof HTMLInputElement && target.type === "file") {
    event.preventDefault();
    void openThroughHost(target);
  }
}

let installed = false;

/** Sends the Export / Import dialog's files through the host (once). */
export function installSettingsFiles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("click", onClick, true);
}
