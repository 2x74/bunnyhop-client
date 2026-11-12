// Settings → Voice chat: the website's voice settings (on/off, push to talk key, voice volume) for the native client,
// whose audio runs in the game (voice_chat.hpp).
import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import { state } from "./bridge";
import { bindRow } from "./native-extras";
import { followHost, nativeToggle, type Ui } from "./native-rows";
import { sendNativeSettings } from "./prefs-bridge";

function voiceGroup(ui: Ui): HTMLElement {
  const group = ui.group(
    "Voice chat",
    nativeToggle(ui, "Voice chat", "voiceEnabled", {
      desc: "Push to talk in rooms. Everyone in the room hears everyone. Guests can listen but need an account to talk.",
      keywords: "voice chat microphone mic talk push to talk ptt alltalk",
    }),
    bindRow(ui, "voiceRecord", "Push to talk"),
    ui.range(
      "Voice volume",
      () => state.settings.voiceVolume,
      (value) => sendNativeSettings({ voiceVolume: value }),
      {
        min: 0,
        max: 1,
        step: 0.05,
        scale: 100,
        unit: "%",
        def: 0.8,
        desc: "How loud other players are. Each player's own volume and mute are on the room screen.",
        keywords: "voice volume voice_scale players loud",
      },
    ),
  );
  followHost(group, ui);
  return group;
}

/** Registers Settings → Voice chat (call once). */
export function registerVoiceSection(): void {
  registerSettingsSection("voice", (ui) => [voiceGroup(ui)], { label: "Voice chat", icon: "audio", order: 72 });
}
