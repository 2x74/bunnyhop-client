// A player's voice menu: from the speaker button on their scoreboard row, or a click on their talker row. Mute (yours,
// remembered in this browser), their volume, for staff / a lobby's host "Mute for the room", and Report. Built on the profile
// menus (social/menu.ts withMenu), so keys, focus and closing work the same.

import { h } from "../ui/dom";
import { icon } from "../ui/icons";
import { withMenu, type MenuItem } from "../social/menu";
import "../social/dock.css";
import { voice } from "./client";
import { voicePeople } from "./people";
import { openFeedback } from "../feedback/state";

function items(slot: number): MenuItem[] {
  const p = voice.person(slot);
  if (!p) return [];
  const id = p.id;
  const muted = voicePeople.muted(id);
  const out = h("output", null, `${Math.round(voicePeople.volume(id) * 100)}%`);
  const range = h("input", { type: "range", min: "0", max: "200", step: "5", value: String(Math.round(voicePeople.volume(id) * 100)), "aria-label": `${p.name}'s voice volume` }) as HTMLInputElement;
  range.addEventListener("input", () => {
    if (!id) return;
    voicePeople.setVolume(id, Number(range.value) / 100);
    out.textContent = `${range.value}%`;
    voice.personChanged(slot);
  });
  // Keys inside the slider move it, not the menu.
  range.addEventListener("keydown", (e) => e.stopPropagation());
  return [
    id ? { label: muted ? "Unmute" : "Mute", run: () => (voicePeople.setMuted(id, !muted), voice.personChanged(slot)) } : null,
    id ? { note: h("label.vm-volume", null, h("span", null, "Volume"), range, out) } : null,
    voice.canRoomMute() && !p.guest ? { label: p.roomMuted ? "Unmute for the room" : "Mute for the room", tone: p.roomMuted ? undefined : "bad", run: () => voice.roomMute(slot, !p.roomMuted) } : null,
    // The player report form (feedback/, apps/api src/player-reports.ts). Nothing of their voice is attached: none is kept.
    id && !p.guest ? { label: "Report", run: () => openFeedback({ category: "report", report: { id, name: p.name }, message: "Voice chat: " }) } : null,
  ];
}

/** The speaker button at the end of a scoreboard name (null for yourself, or when the room has no voice). */
export function voiceButton(r: { slot: number; you: boolean; name: string; id?: string }): HTMLElement | null {
  if (r.you || !voice.active) return null;
  const p = voice.person(r.slot);
  const muted = voicePeople.muted(r.id ?? p?.id);
  const talking = voice.isTalking(r.slot);
  const b = h(
    `button.sb-voice${muted ? ".muted" : ""}${talking ? ".talking" : ""}${p?.roomMuted ? ".room-muted" : ""}`,
    { type: "button", "aria-label": `${r.name}: voice${muted ? " (muted)" : ""}`, title: muted ? "Muted" : p?.roomMuted ? "Muted for the room" : "Voice" },
    icon(muted || p?.roomMuted ? "audioOff" : "audio"),
  ) as HTMLButtonElement;
  return withMenu(b, () => items(r.slot), { align: "left", label: `${r.name}'s voice` });
}

/** Opens the voice menu at `anchor` (a talker row). */
export function openVoiceMenu(anchor: HTMLElement, slot: number): void {
  const b = h("button.sb-voice", { type: "button", style: "position:absolute;inset:0;opacity:0" }) as HTMLButtonElement;
  anchor.style.position ||= "relative";
  anchor.append(b);
  withMenu(b, () => items(slot), { align: "left", label: "Voice" });
  b.click();
  // The menu keeps its own reference; the stand-in button goes once it closes.
  const gone = () => b.getAttribute("aria-expanded") !== "true" && (b.remove(), true);
  const poll = window.setInterval(() => gone() && clearInterval(poll), 500);
}
