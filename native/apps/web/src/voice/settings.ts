// Settings -> Audio -> Voice chat: on / off, the push to talk key, everyone's volume, the microphone and its level. The
// meter only listens once the browser already allows the microphone or you press Test: opening settings never asks.

import type * as Controls from "../ui/controls";
import { h } from "../ui/dom";
import { keyLabel, prefs, type Prefs } from "../ui/settings";
import { mouseCode } from "../binds";
import { microphones } from "./capture";
import { voice } from "./client";

const P = () => prefs.get();
const up = (fn: (p: Prefs) => void) => prefs.update(fn);

/** Waits for one key or mouse button (Esc cancels, Backspace / Delete unbinds). */
function capture(b: HTMLButtonElement, paint: () => void): void {
  b.textContent = "Press a key…";
  b.classList.add("capturing");
  const done = (code: string | null | undefined) => {
    removeEventListener("keydown", key, true);
    removeEventListener("mousedown", mouse, true);
    b.classList.remove("capturing");
    if (code !== undefined) up((p) => (p.voice.key = code ?? ""));
    paint();
  };
  const key = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    done(e.key === "Escape" ? undefined : e.key === "Backspace" || e.key === "Delete" ? null : e.code);
  };
  const mouse = (e: MouseEvent) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    done(mouseCode(e.button));
  };
  setTimeout(() => (addEventListener("keydown", key, true), addEventListener("mousedown", mouse, true)), 0);
}

/**
 * The push to talk key's row: here and in Settings -> Keys -> Run, one pref (Prefs.voice.key). `keysLayout`: laid out
 * like the bind rows around it (first slot, no reset).
 */
export function pushToTalkRow(ui: typeof Controls, keysLayout = false): HTMLElement {
  const keyBtn = h("button.bind", { type: "button" }) as HTMLButtonElement;
  const paintKey = () => {
    const k = P().voice.key;
    keyBtn.textContent = k ? keyLabel(k) : "—";
    keyBtn.classList.toggle("empty", !k);
  };
  paintKey();
  keyBtn.addEventListener("click", () => capture(keyBtn, paintKey));
  const control = keysLayout ? h("div.bind-line", null, h("div.bind-pair", null, keyBtn), h("span.bind-reset", { "aria-hidden": "true" })) : keyBtn;
  const r = ui.row("Push to talk", control, { desc: "Hold to talk in a room. Outside rooms the key keeps its other bind.", keywords: "voice ptt push to talk key bind voicerecord +voicerecord mic microphone" });
  if (keysLayout) r.classList.add("bind-row");
  return r;
}

/** The Voice chat group (audio/settings-section.ts puts it in the right column). */
export function voiceGroup(ui: typeof Controls): HTMLElement {
  const pct = { min: 0, max: 1, step: 0.05, scale: 100, unit: "%" } as const;

  // Microphone list: labels only show after the browser allows the microphone.
  const pick = h("select", { "aria-label": "Microphone" }) as HTMLSelectElement;
  const fill = async () => {
    const list = await microphones();
    const cur = P().voice.device;
    pick.replaceChildren(h("option", { value: "" }, "Default"), ...list.map((m) => h("option", { value: m.id }, m.label)));
    pick.value = list.some((m) => m.id === cur) ? cur : "";
  };
  void fill();
  pick.addEventListener("change", () => up((p) => (p.voice.device = pick.value)));
  navigator.mediaDevices?.addEventListener?.("devicechange", () => void fill());

  const bar = h("i");
  const meter = h("div.voice-meter.idle", { role: "meter", "aria-label": "Microphone level", "aria-valuemin": "0", "aria-valuemax": "100" }, bar);
  let stop: (() => void) | null = null;
  const show = (level: number) => {
    if (!meter.isConnected) return stop?.(), (stop = null);
    meter.classList.remove("idle");
    bar.style.width = `${Math.round(level * 100)}%`;
    meter.setAttribute("aria-valuenow", String(Math.round(level * 100)));
  };
  const listen = async (ask: boolean) => {
    if (stop) return;
    stop = await voice.meter(show, ask);
    if (stop) void fill();
  };
  void listen(false);
  const test = ui.button("Test", () => void listen(true));

  return ui.group(
    "Voice chat",
    ui.toggle("Voice chat", () => P().voice.enabled, (v) => up((p) => (p.voice.enabled = v)), { desc: "Hear the room and talk with push to talk.", keywords: "voice chat talk microphone mic push to talk ptt voice_enable" }),
    pushToTalkRow(ui),
    ui.range("Voice volume", () => P().voice.volume, (v) => up((p) => (p.voice.volume = v)), { ...pct, desc: "Everyone's voice. One player's is on the scoreboard.", keywords: "voice volume voice_scale loud quiet" }),
    ui.row("Microphone", pick, { keywords: "microphone mic input device headset" }),
    ui.row("Microphone level", h("div.btn-row", null, meter, test), { keywords: "microphone mic level meter test input" }),
  );
}
