// The speaker button in the bottom right of every menu screen (web audio/ui.ts mountAudioChrome, styled by
// audio/audio.css #audio-btn). The host owns the mixer: the button flips the "muted" setting and follows it back.

import "../../web/src/audio/audio.css";
import { keyLabel } from "../../web/src/ui/settings";
import { send, state } from "./bridge";

// The web's two speaker icons (audio/ui.ts ICON_ON / ICON_OFF).
const ICON_ON = [
  `<svg viewBox="0 0 24 24" aria-hidden="true">`,
  `<path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/>`,
  `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"`,
  ` d="M16 9.2a4 4 0 0 1 0 5.6M18.6 6.6a7.6 7.6 0 0 1 0 10.8"/>`,
  `</svg>`,
].join("");
const ICON_OFF = [
  `<svg viewBox="0 0 24 24" aria-hidden="true">`,
  `<path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z"/>`,
  `<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16.5 9.5l5 5M21.5 9.5l-5 5"/>`,
  `</svg>`,
].join("");

let button: HTMLButtonElement | null = null;
let painted = "";

function paint(): void {
  if (!button) return;
  const muted = state.settings.muted;
  const code = state.settings.binds.mute?.[0];
  const label = `${muted ? "Unmute" : "Mute"} sound${code ? ` (${keyLabel(code)})` : ""}`;
  const key = `${muted}:${label}`;
  if (key === painted) return;
  painted = key;
  button.innerHTML = muted ? ICON_OFF : ICON_ON;
  button.classList.toggle("off", muted);
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(muted));
}

export function installMuteButton(): void {
  if (button) return;
  button = document.createElement("button");
  button.type = "button";
  button.id = "audio-btn";
  button.addEventListener("click", () => {
    const muted = !state.settings.muted;
    // Shown at once; the host's next state confirms it.
    state.settings.muted = muted;
    send({ type: "settings", patch: { muted } });
    paint();
  });
  document.body.append(button);
  window.addEventListener("bunnyhop:host-state", paint);
  paint();
}
