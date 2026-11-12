// The website's Audio → Voice chat group (apps/web/src/voice/settings.ts). Native has its own Settings → Voice chat
// section (voice-section.ts) driving the game's voice, so the web group is left out of the Audio section.
export function voiceGroup(_ui: unknown): HTMLElement {
  const empty = document.createElement("div");
  empty.hidden = true;
  return empty;
}
