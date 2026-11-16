// The website's Audio → Voice chat group (apps/web/src/voice/settings.ts). Native has its own Settings → Voice chat
// section (voice-section.ts) driving the game's voice, so the web group is left out of the Audio section.
import { bindRow } from "./native-extras";
import type { Ui } from "./native-rows";

export function voiceGroup(_ui: unknown): HTMLElement {
  const empty = document.createElement("div");
  empty.hidden = true;
  return empty;
}

/** Keys → Run's Push to talk row: the game's own voiceRecord bind, as in Settings → Voice chat. */
export function pushToTalkRow(ui: Ui, _keysLayout = false): HTMLElement {
  return bindRow(ui, "voiceRecord", "Push to talk");
}
