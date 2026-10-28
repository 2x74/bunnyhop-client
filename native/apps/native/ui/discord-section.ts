// Settings → Discord: Rich Presence and Join, which only the native client has.

import { h } from "../../web/src/ui/dom";
import { registerSettingsSection } from "../../web/src/ui/settings-registry";
import { state } from "./bridge";
import { followHost, nativeToggle, type Ui } from "./native-rows";

const STATUS_TEXT = {
  disabled: "Off",
  connecting: "Connecting…",
  ready: "Connected",
  reconnecting: "Discord not found",
};

function statusText(): string {
  if (state.settings.privacyMode) return "Privacy mode";
  if (!state.settings.discordRichPresence) return STATUS_TEXT.disabled;
  return STATUS_TEXT[state.discord.state];
}

function presenceGroup(ui: Ui): HTMLElement {
  const status = h("small.set-readout");
  const group = ui.group(
    "Rich Presence",
    nativeToggle(ui, "Show on Discord", "discordRichPresence", {
      readout: status,
      desc: "Shows what you're playing on your Discord profile. Needs the Discord desktop app running.",
      keywords: "discord rich presence status activity profile",
    }),
    nativeToggle(ui, "Show the map", "discordShowMap", {
      desc: "Off shows only that you're bunnyhopping, not where.",
      keywords: "discord map presence",
    }),
    nativeToggle(ui, "Privacy mode", "privacyMode", {
      hint: "Hides everything",
      desc: "Turns presence and Join off without changing the switches above.",
      keywords: "discord privacy hide stream",
    }),
  );
  const paint = (): void => {
    status.textContent = statusText();
    status.title = state.discord.message;
  };
  followHost(group, ui, paint);
  // The connection changes without a settings change.
  const onState = (): void => {
    if (group.isConnected) paint();
    else if (seen) removeEventListener("bunnyhop:host-state", onState);
    seen ||= group.isConnected;
  };
  let seen = false;
  addEventListener("bunnyhop:host-state", onState);
  return group;
}

function joinGroup(ui: Ui): HTMLElement {
  return ui.group(
    "Join",
    nativeToggle(ui, "Let friends join", "discordJoin", {
      hint: "Public servers",
      desc: "While you're on a public server, friends get a Join button on your Discord profile.",
      keywords: "discord join invite friends",
    }),
    nativeToggle(ui, "Include private lobbies", "discordJoinLobbies", {
      desc: "Also offer Join from a private lobby. Anyone who can see your profile could then get in.",
      keywords: "discord join private lobby",
    }),
  );
}

/** Registers Settings → Discord (call once). */
export function registerDiscordSection(): void {
  registerSettingsSection("discord", (ui) => ({ columns: [[presenceGroup(ui)], [joinGroup(ui)]] }), {
    label: "Discord",
    icon: "message",
    order: 80,
  });
}
