import { h } from "../../web/src/ui/dom";
import { ACTIONS, keyLabel } from "../../web/src/ui/settings";
import { mouseCode } from "../../web/src/binds";
import { AUDIO_PACKS, NATIVE_BIND_ACTIONS, send, settingsPatch, state, nativeKeyCode, type AudioPack, type NativeSettings } from "./bridge";

// The settings screen, laid out like the game's own (AIRTIME): a rail of
// sections on the left, label | control rows on raised strips, the game's
// switches and segmented controls, and a help line under the page that follows
// whichever row is hovered or focused. Every change is sent at once and a tick
// at the foot of the rail flashes. Every native setting applies live, so there
// is no restart bar.

type Control = HTMLInputElement | HTMLElement;
interface Section { id: string; title: string; body: HTMLElement }
type BindAction = (typeof NATIVE_BIND_ACTIONS)[number];

const BIND_GROUPS: readonly { title: string; actions: readonly BindAction[] }[] = [
  { title: "Movement", actions: ["forward", "back", "left", "right", "jump", "duck", "use"] },
  { title: "Runs", actions: ["restart", "restartMain", "restartBonus", "cycleStyle"] },
  { title: "Weapons", actions: ["attack", "attack2", "inspect", "reload", "slot1", "slot2", "slot3", "lastWeapon", "drop", "giveUsp", "giveGlock"] },
  { title: "Interface", actions: ["viewmodel", "hideUi", "mute"] },
];

export function settingsPanel(): HTMLElement {
  const controls = new Map<keyof NativeSettings, Control>();
  const help = h("p.nset-help", { "aria-live": "polite" });
  const status = h("p.nset-status", { role: "status" });
  const saved = h("span.nset-saved", { "aria-hidden": "true" }, "✓ Saved");
  let savedTimer = 0;
  const flashSaved = (): void => {
    saved.classList.add("on"); window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => saved.classList.remove("on"), 1100);
  };
  const say = (text: string): void => { status.textContent = text; };

  function save(patch: Partial<NativeSettings>): void {
    const valid = settingsPatch(patch);
    if (!Object.keys(valid).length) return;
    send({ type: "settings", patch: valid });
    say(""); flashSaved();
  }

  // One strip: the name (with an optional short hint under it) on the left, the
  // control on the right. |about| is the longer text for the help line.
  function row(name: string, control: HTMLElement, hint = "", about = ""): HTMLElement {
    const el = h("div.nset-row", null, h("span.nset-name", null, name, hint ? h("small.nset-hint", null, hint) : null), control);
    const show = (): void => { help.textContent = about || hint; };
    el.addEventListener("pointerenter", show); el.addEventListener("focusin", show);
    return el;
  }
  const group = (title: string, ...rows: HTMLElement[]): HTMLElement =>
    h("div.nset-group", null, title ? h("h3.nset-group-title", null, title) : null, h("div.nset-group-rows", null, ...rows));

  function number(name: string, key: keyof NativeSettings, min: number, max: number, step: number, hint = "", about = "", unit = ""): HTMLElement {
    const input = h("input.num-input", { type: "number", min, max, step, value: Number(state.settings[key]), "aria-label": name });
    if (key === "sensitivity") input.classList.add("native-sensitivity");
    controls.set(key, input);
    input.addEventListener("change", () => {
      const value = input.valueAsNumber;
      if (!Number.isFinite(value) || value < min || value > max || (key === "fpsLimit" && value !== 0 && value < 30)) {
        say(key === "fpsLimit" ? "FPS limit is 0 (unlimited) or 30–1000." : `${name}: choose ${min}–${max}.`);
        input.value = String(state.settings[key]); return;
      }
      save({ [key]: value });
    });
    return row(name, h("span.num-wrap", null, input, unit ? h("span.unit", null, unit) : null), hint, about);
  }
  function toggle(name: string, key: keyof NativeSettings, hint = "", about = ""): HTMLElement {
    const input = h("input.switch", { type: "checkbox", checked: !!state.settings[key], "aria-label": name });
    controls.set(key, input);
    input.addEventListener("change", () => save({ [key]: input.checked }));
    const el = row(name, input, hint, about);
    el.classList.add("nset-row-toggle");
    // The whole strip toggles, as in the game.
    el.addEventListener("click", event => { if (event.target !== input && !input.disabled) input.click(); });
    return el;
  }
  function pack(name: string, key: "sfxPack" | "musicPack", defaultLabel: string, about: string): HTMLElement {
    const text: Record<AudioPack, string> = { default: defaultLabel, custom: "Custom" };
    const seg = h("div.seg", { role: "radiogroup", "aria-label": name });
    for (const value of AUDIO_PACKS)
      seg.append(h("button", { type: "button", role: "radio", "data-value": value, onclick: () => save({ [key]: value }) }, text[value]));
    controls.set(key, seg);
    return row(name, seg, "", about);
  }

  const mouse = h("div.nset-cols", null,
    group("",
      number("Mouse sensitivity", "sensitivity", .01, 100, .01, "", "Same scale as the game and CS:S: each mouse count turns sensitivity × 0.022 degrees."),
      toggle("Separate vertical sensitivity", "separateVertical", "", "Use a different sensitivity for looking up and down."),
      number("Vertical sensitivity", "verticalSensitivity", .01, 100, .01, "", "Only used when separate vertical sensitivity is on.")));
  const display = h("div.nset-cols", null,
    group("Video",
      number("Field of view", "fov", 60, 130, 1, "", "Field of view in degrees.", "°"),
      toggle("Vertical sync", "vsync", "", "Locks frames to your monitor's refresh rate. Off gives the lowest input latency."),
      number("FPS limit", "fpsLimit", 0, 1000, 1, "0 is unlimited", "Caps the frame rate. 0 means no cap; otherwise 30–1000.")),
    group("HUD",
      toggle("HUD", "hud", "", "Speed, timer and keys."),
      toggle("Crosshair", "crosshair"),
      toggle("Viewmodel", "viewmodel", "", "Your weapon and hands."),
      toggle("Jump stats", "jumpStats", "JHUD / SSJ", "Speed on the sixth jump and per-jump gain, ported from the game's !ssj.")));
  const audio = h("div.nset-cols", null,
    group("Volume",
      number("Volume", "volume", 0, 1, .01, "0 to 1", "Master volume for sound effects and music."),
      toggle("Mute", "muted")),
    group("Packs",
      pack("Sound effects", "sfxPack", "bunnyhop.lol SFX",
        "Custom sounds come from the sound folder in your Bunnyhop Native data directory. Name a file after the cue it replaces, such as jump.wav; WAV, MP3, FLAC or Ogg all work. Cues you haven't supplied keep the bunnyhop.lol sound."),
      pack("Music", "musicPack", "bunnyhop.lol OST", "Custom music comes from the bgm folder beside it, played in filename order.")));

  let capturing: string | null = null, appendBinding = false;
  const buttons = new Map<string, HTMLButtonElement>();
  const bindRow = (action: BindAction): HTMLElement => {
    const label = ACTIONS.find(item => item.id === action)?.label ?? action;
    const button = h("button.bind", { type: "button", "aria-label": `${label} binding`, onclick: () => { capturing = action; appendBinding = false; refresh(); } });
    const add = h("button.link-btn", { type: "button", title: "Add another key", onclick: () => { capturing = action; appendBinding = true; refresh(); } }, "Add");
    const clear = h("button.link-btn", { type: "button", title: "Unbind", onclick: () => save({ binds: { [action]: [] } }) }, "Clear");
    buttons.set(action, button);
    return row(label, h("div.nset-bind", null, button, add, clear), "", "Click, then press a key, mouse button or wheel direction. Escape cancels. Escape and F10 stay reserved. Up to four keys each.");
  };
  const keys = h("div.nset-cols", null, ...BIND_GROUPS.map(item => group(item.title, ...item.actions.map(bindRow))));

  const sections: Section[] = [
    { id: "mouse", title: "Mouse", body: mouse },
    { id: "display", title: "Display", body: display },
    { id: "audio", title: "Audio", body: audio },
    { id: "keys", title: "Keys", body: keys },
  ];

  const scroll = h("div.nset-scroll", { tabindex: "-1" });
  const rail = h("nav.nset-rail", { "aria-label": "Settings sections" });
  const railItems = new Map<string, HTMLButtonElement>();
  const mark = (id: string): void => {
    for (const [key, item] of railItems) { item.classList.toggle("on", key === id); item.setAttribute("aria-current", key === id ? "true" : "false"); }
  };
  for (const section of sections) {
    const el = h("section.nset-sec", { id: `nset-${section.id}`, "aria-labelledby": `nset-${section.id}-h` },
      h("div.nset-sec-head", null, h("h2", { id: `nset-${section.id}-h` }, section.title)), section.body);
    scroll.append(el);
    const item = h("button.nset-rail-item", { type: "button", onclick: () => { el.scrollIntoView({ block: "start", behavior: "smooth" }); mark(section.id); } }, section.title);
    railItems.set(section.id, item); rail.append(item);
  }
  // Light the section whose head has reached the top of the page.
  scroll.addEventListener("scroll", () => {
    const top = scroll.getBoundingClientRect().top + 24;
    let current = sections[0].id;
    for (const section of sections) { const el = document.getElementById(`nset-${section.id}`); if (el && el.getBoundingClientRect().top <= top) current = section.id; }
    if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2) current = sections[sections.length - 1].id;
    mark(current);
  }, { passive: true });
  mark(sections[0].id);
  scroll.addEventListener("pointerleave", () => { help.textContent = ""; });

  const root = h("div.nset", null, h("div.nset-side", null, rail, saved), scroll, h("div.nset-foot", null, help, status));

  let previous: Partial<NativeSettings> = {};
  function refresh(): void {
    for (const [key, control] of controls) {
      if (document.activeElement === control || previous[key] === state.settings[key]) continue;
      if (control instanceof HTMLInputElement && control.type === "checkbox") control.checked = !!state.settings[key];
      else if (control instanceof HTMLInputElement) control.value = String(state.settings[key]);
      else for (const button of control.querySelectorAll<HTMLButtonElement>("button")) {
        const on = button.dataset.value === state.settings[key];
        button.classList.toggle("on", on); button.setAttribute("aria-checked", on ? "true" : "false");
      }
    }
    previous = { ...state.settings };
    const vertical = controls.get("verticalSensitivity");
    if (vertical instanceof HTMLInputElement) { vertical.disabled = !state.settings.separateVertical; vertical.closest(".nset-row")?.classList.toggle("off", vertical.disabled); }
    for (const [action, button] of buttons) {
      const codes = state.settings.binds[action] ?? [];
      button.classList.toggle("capturing", capturing === action);
      button.classList.toggle("empty", capturing !== action && !codes.length);
      button.textContent = capturing === action ? (appendBinding ? "Press another…" : "Press a key…") : codes.map(keyLabel).join(" / ") || "Unbound";
    }
  }

  const capture = (event: Event): void => {
    if (!capturing) return;
    let code: string | null = null;
    if (event instanceof KeyboardEvent) {
      if (event.type !== "keydown") return;
      if (event.code === "Escape") { capturing = null; refresh(); event.preventDefault(); event.stopImmediatePropagation(); return; }
      code = event.code;
    } else if (event instanceof WheelEvent) code = event.deltaY < 0 ? "MWheelUp" : "MWheelDown";
    else if (event instanceof MouseEvent) { if (event.type !== "mousedown") return; code = mouseCode(event.button); }
    if (!nativeKeyCode(code)) { say("That key is reserved or not supported by the native client."); return; }
    event.preventDefault(); event.stopImmediatePropagation();
    const action = capturing; capturing = null;
    const patch: Record<string, string[]> = {};
    for (const [other, codes] of Object.entries(state.settings.binds)) if (other !== action && codes.includes(code)) patch[other] = codes.filter(value => value !== code);
    const codes = appendBinding ? [...new Set([...(state.settings.binds[action] ?? []), code])] : [code];
    if (codes.length > 4) { say("Each action takes up to four keys."); refresh(); return; }
    patch[action] = codes; save({ binds: patch });
    const moved = Object.keys(patch).filter(other => other !== action).map(other => ACTIONS.find(item => item.id === other)?.label ?? other);
    if (moved.length) say(`${keyLabel(code)} moved from ${moved.join(", ")}.`);
    refresh();
  };
  for (const name of ["keydown", "mousedown", "wheel"]) root.addEventListener(name, capture, { capture: true, passive: false });

  const onState = (): void => { if (!root.isConnected) { window.removeEventListener("bunnyhop:host-state", onState); return; } refresh(); };
  window.addEventListener("bunnyhop:host-state", onState);
  refresh();
  return root;
}
