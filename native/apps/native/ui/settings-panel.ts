import { h } from "../../web/src/ui/dom";
import { ACTIONS, keyLabel } from "../../web/src/ui/settings";
import { mouseCode } from "../../web/src/binds";
import { HUD_ELEMENTS, defaultPosition, type HudElementId, type HudLayout } from "./hud-layout";
import { AUDIO_PACKS, HUD_SCALE_PERCENT, DEFAULT_YAW_SPEED, DEFAULT_YAW_SPEED_ALT, JUMP_STATS_MODES, NATIVE_BIND_ACTIONS, send, settingsPatch, state, nativeKeyCode, type AudioPack, type JumpStatsMode, type NativeSettings } from "./bridge";

const DISCORD_TEXT={disabled:"Off",connecting:"Connecting…",ready:"Connected",reconnecting:"Discord not found"} as const;
const DISCORD_TONE={disabled:"",connecting:"busy",ready:"ok",reconnecting:"bad"} as const;

// The settings screen, laid out like the game's own (AIRTIME): a rail of
// sections on the left, label | control rows on raised strips, the game's
// switches and segmented controls, and a help line under the page that follows
// whichever row is hovered or focused. Every change is sent at once and a tick
// at the foot of the rail flashes. Every native setting applies live, so there
// is no restart bar.

type Control = HTMLInputElement | HTMLElement;
interface Section { id: string; title: string; body: HTMLElement }
type BindAction = (typeof NATIVE_BIND_ACTIONS)[number];

// Labels for native-only actions the web game's list doesn't have.
const NATIVE_LABELS: Partial<Record<string, string>> = { turnFast: "Turn modifier (alt yaw speed)" };
const actionLabel = (action: string): string => NATIVE_LABELS[action] ?? ACTIONS.find(item => item.id === action)?.label ?? action;

const BIND_GROUPS: readonly { title: string; actions: readonly BindAction[] }[] = [
  { title: "Movement", actions: ["forward", "back", "left", "right", "jump", "duck", "use"] },
  { title: "Runs", actions: ["restart", "restartMain", "restartBonus", "cycleStyle", "mainMenu"] },
  { title: "Weapons", actions: ["attack", "attack2", "inspect", "reload", "slot1", "slot2", "slot3", "lastWeapon", "drop", "giveUsp", "giveGlock"] },
  { title: "Interface", actions: ["viewmodel", "hideUi", "mute"] },
  { title: "Turning", actions: ["turnLeft", "turnRight", "turnFast"] },
  // Practice (web practice-mode/): practice mode's toggle, then the tools. During a timed run Z / X only act while the
  // !cp menu is open; C always saves.
  { title: "Practice", actions: ["practice", "noclip", "cpSave", "cpTeleport", "cpPrev", "cpNext"] },
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
  function row(name: string, control: HTMLElement, hint = "", about = "", search = `${name} ${hint} ${about}`): HTMLElement {
    const el = h("div.nset-row", { "data-search": search.toLowerCase() }, h("span.nset-name", null, name, hint ? h("small.nset-hint", null, hint) : null), control);
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
      if (!Number.isFinite(value) || value < min || value > max || (key === "fpsLimit" && value !== 0 && value < 30) || ((key === "jumpStatsInterval" || key === "strafeTrainerSmoothing") && !Number.isInteger(value))) {
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

  function jumpStatsMode(): HTMLElement {
    const text: Record<JumpStatsMode, string> = { sixth: "6th jump", every: "Every jump", interval: "Every N" };
    const seg = h("div.seg", { role: "radiogroup", "aria-label": "Show jump stats on" });
    for (const value of JUMP_STATS_MODES)
      seg.append(h("button", { type: "button", role: "radio", "data-value": value, onclick: () => save({ jumpStatsMode: value }) }, text[value]));
    controls.set("jumpStatsMode", seg);
    return row("Show on", seg, "", "6th jump: only jump 6, compared with jump 1, like !ssj. Every jump: each jump compared with the one before. Every N: jumps N, 2N, 3N ..., each compared with the last one shown.");
  }

  // A yaw speed: a slider and a box showing the same number (the box keeps any
  // precision, the slider moves in tenths), and Default to go back.
  const speedSyncs: (() => void)[] = [];
  let speedTimer = 0; const pendingSpeed: Partial<NativeSettings> = {};
  function speed(name: string, key: "yawSpeed" | "yawSpeedAlt", fallback: number, hint: string, about: string): HTMLElement {
    const range = h("input.nset-range", { type: "range", min: 1, max: 500, step: .1, "aria-label": `${name} slider` }) as HTMLInputElement;
    const box = h("input.num-input", { type: "number", min: .01, max: 1000, step: "any", "aria-label": name }) as HTMLInputElement;
    const reset = h("button.link-btn", { type: "button", title: `Back to ${fallback}` }, "Default") as HTMLButtonElement;
    // Keep the local edit until the host echoes it; older periodic state can
    // arrive both before the debounce and after the patch has been dispatched.
    let draft: number | undefined;
    const send = (value: number, now: boolean): void => {
      draft = value; pendingSpeed[key] = value;
      const flush = (): void => { speedTimer = 0; if (Object.keys(pendingSpeed).length) { save({ ...pendingSpeed }); for (const k of Object.keys(pendingSpeed)) delete pendingSpeed[k as keyof NativeSettings]; } };
      if (now) { window.clearTimeout(speedTimer); flush(); } else if (!speedTimer) speedTimer = window.setTimeout(flush, 100);
      sync();
    };
    const sync = (): void => {
      if (draft === state.settings[key]) draft = undefined;
      const value = draft ?? state.settings[key];
      if (document.activeElement !== box) box.value = String(value);
      if (draft !== undefined || document.activeElement !== range) range.value = String(value);
      reset.disabled = value === fallback;
    };
    range.addEventListener("input", () => send(range.valueAsNumber, false));
    range.addEventListener("change", () => send(range.valueAsNumber, true));
    box.addEventListener("change", () => {
      const value = box.valueAsNumber;
      if (!Number.isFinite(value) || value < .01 || value > 1000) { say(`${name}: choose .01–1000.`); box.value = String(state.settings[key]); return; }
      send(value, true);
    });
    reset.addEventListener("click", () => send(fallback, true));
    speedSyncs.push(sync); sync();
    const el = row(name, h("div.nset-speed", null, range, h("span.num-wrap", null, box, h("span.unit", null, "°/s")), reset), hint, about, `${name} ${hint} ${about} turnbind turn yaw speed cl_yawspeed +left +right`);
    el.classList.add("nset-row-pos");
    return el;
  }

  // HUD scale (web settings-panel.ts: 50–175 %, steps of 5): a slider and a box, Default for 100 %.
  function hudScale(): HTMLElement {
    const { min, max, step } = HUD_SCALE_PERCENT;
    const range = h("input.nset-range", { type: "range", min, max, step, "aria-label": "HUD scale slider" }) as HTMLInputElement;
    const box = h("input.num-input", { type: "number", min, max, step, "aria-label": "HUD scale" }) as HTMLInputElement;
    const reset = h("button.link-btn", { type: "button", title: "Back to 100%" }, "Default") as HTMLButtonElement;
    let draft: number | undefined, timer = 0;
    const sync = (): void => {
      if (draft === state.settings.hudScale) draft = undefined;
      const value = draft ?? state.settings.hudScale;
      if (document.activeElement !== box) box.value = String(value);
      if (draft !== undefined || document.activeElement !== range) range.value = String(value);
      reset.disabled = value === 100;
    };
    const apply = (value: number, now: boolean): void => {
      value = Math.round(value);
      if (!Number.isFinite(value) || value < min || value > max) { say(`HUD scale: choose ${min}–${max}%.`); draft = undefined; sync(); return; }
      draft = value; sync();
      window.clearTimeout(timer);
      // While dragging, at most every 100 ms, so the HUD follows.
      if (now) save({ hudScale: value }); else timer = window.setTimeout(() => save({ hudScale: value }), 100);
    };
    range.addEventListener("input", () => apply(range.valueAsNumber, false));
    range.addEventListener("change", () => apply(range.valueAsNumber, true));
    box.addEventListener("change", () => apply(box.valueAsNumber, true));
    reset.addEventListener("click", () => apply(100, true));
    speedSyncs.push(sync); sync();
    const el = row("HUD scale", h("div.nset-speed", null, range, h("span.num-wrap", null, box, h("span.unit", null, "%")), reset), "",
      "The whole HUD, chat included. The gaps between elements grow with it.", "HUD scale hud size scale bigger smaller ultrawide 21:9 1440p 4k resolution small text");
    el.classList.add("nset-row-pos");
    return el;
  }

  const mouse = h("div.nset-cols", null,
    group("",
      number("Mouse sensitivity", "sensitivity", .01, 100, .01, "", "Same scale as the game and CS:S: each mouse count turns sensitivity × 0.022 degrees."),
      toggle("Separate vertical sensitivity", "separateVertical", "", "Use a different sensitivity for looking up and down."),
      number("Vertical sensitivity", "verticalSensitivity", .01, 100, .01, "", "Only used when separate vertical sensitivity is on.")),
    group("Turnbinds",
      speed("Yaw speed", "yawSpeed", DEFAULT_YAW_SPEED, "cl_yawspeed", "How fast Turn left / Turn right (+left / +right) turn you, in degrees per second. Bind them under Keys > Turning. Only 210°/s supports ranked submission; other speeds keep the attempt local."),
      h("p.nset-hint", null, "For ranked turn binds, set both speeds to 210°/s. Using another speed keeps that attempt as a local replay.")));
  const display = h("div.nset-cols", null,
    group("Video",
      number("Field of view", "fov", 60, 130, 1, "", "Field of view in degrees.", "°"),
      toggle("Vertical sync", "vsync", "", "Locks frames to your monitor's refresh rate. Off gives the lowest input latency."),
      number("FPS limit", "fpsLimit", 0, 1000, 1, "0 is unlimited", "Caps the frame rate. 0 means no cap; otherwise 30–1000.")));

  // ---- HUD positions (Advanced) -------------------------------------------
  // Each element gets an X and a Y: a slider and a box showing the same
  // number, in percent of the screen. Untouched elements show where the game
  // draws them by default; Reset puts one back there.
  const positions = new Map<HudElementId, { x: HTMLInputElement[]; y: HTMLInputElement[]; reset: HTMLButtonElement; row: HTMLElement }>();
  const layout = (): HudLayout => ({ ...state.settings.hudLayout });
  const placed = (id: HudElementId) => state.settings.hudLayout[id] ?? defaultPosition(id);
  let layoutTimer = 0, pendingLayout: HudLayout | null = null;
  const saveLayout = (next: HudLayout, now = false): void => {
    // Sliders send while dragging, at most every 100 ms, so the HUD follows.
    state.settings.hudLayout = next; pendingLayout = next;
    const flush = (): void => { layoutTimer = 0; if (pendingLayout) { save({ hudLayout: pendingLayout }); pendingLayout = null; } };
    if (now) { window.clearTimeout(layoutTimer); flush(); }
    else if (!layoutTimer) layoutTimer = window.setTimeout(flush, 100);
  };
  function position(id: HudElementId, label: string): HTMLElement {
    const inputs = { x: [] as HTMLInputElement[], y: [] as HTMLInputElement[] };
    const axis = (name: "x" | "y"): HTMLElement => {
      const range = h("input.nset-range", { type: "range", min: 0, max: 100, step: .1, "aria-label": `${label} ${name.toUpperCase()} slider` }) as HTMLInputElement;
      const box = h("input.num-input.nset-pos-num", { type: "number", min: 0, max: 100, step: .1, "aria-label": `${label} ${name.toUpperCase()}` }) as HTMLInputElement;
      inputs[name].push(range, box);
      const apply = (value: number, now: boolean): void => {
        if (!Number.isFinite(value) || value < 0 || value > 100) { say(`${label} ${name.toUpperCase()}: choose 0–100%.`); refreshPositions(true); return; }
        value = Math.round(value * 10) / 10;
        for (const input of inputs[name]) if (input !== document.activeElement || input === range) input.value = String(value);
        saveLayout({ ...layout(), [id]: { ...placed(id), [name]: value } }, now);
        positions.get(id)?.row.classList.add("moved");
      };
      range.addEventListener("input", () => apply(range.valueAsNumber, false));
      range.addEventListener("change", () => apply(range.valueAsNumber, true));
      box.addEventListener("change", () => apply(box.valueAsNumber, true));
      return h("label.nset-axis", null, h("span.nset-axis-name", null, name.toUpperCase()), range, box, h("span.unit", null, "%"));
    };
    const reset = h("button.link-btn", { type: "button", title: `Put ${label} back where it was`, onclick: () => {
      const next = layout(); delete next[id]; saveLayout(next, true); refreshPositions(true);
    } }, "Reset") as HTMLButtonElement;
    const el = row(label, h("div.nset-pos", null, axis("x"), axis("y"), reset), "", `Where ${label.toLowerCase()} sits on screen, in percent: X from the left, Y from the top.`,
      `${label} position x y move hud layout advanced`);
    el.classList.add("nset-row-pos");
    positions.set(id, { ...inputs, reset, row: el });
    return el;
  }
  function refreshPositions(force = false): void {
    for (const [id, item] of positions) {
      const at = placed(id), moved = !!state.settings.hudLayout[id];
      for (const name of ["x", "y"] as const)
        for (const input of item[name]) if (force || input !== document.activeElement) input.value = String(at[name]);
      item.reset.disabled = !moved; item.row.classList.toggle("moved", moved);
    }
  }
  const resetAll = h("button.link-btn", { type: "button", onclick: () => { saveLayout({}, true); refreshPositions(true); } }, "Reset all");
  const advanced = h("details.nset-advanced", null,
    h("summary", null, h("span", null, "Advanced: positions"), h("small.nset-hint", null, "Move any part of the HUD")),
    h("div.nset-advanced-body", null,
      h("div.nset-advanced-bar", null, h("span.nset-hint", null, "X is from the left, Y from the top, in percent of the screen."), resetAll),
      group("", ...HUD_ELEMENTS.map(item => position(item.id, item.label)))));
  window.addEventListener("resize", () => refreshPositions());

  const hud = h("div.nset-hud", null,
    h("div.nset-cols", null,
      group("HUD",
        toggle("HUD", "hud", "", "Speed, timer and keys."),
        hudScale(),
        toggle("Crosshair", "crosshair"),
        toggle("Viewmodel", "viewmodel", "", "Your weapon and hands.")),
      group("Jump stats",
        toggle("Jump stats", "jumpStats", "JHUD / SSJ", "Speed and gain per jump, ported from the game's !ssj."),
        jumpStatsMode(),
        number("N", "jumpStatsInterval", 2, 50, 1, "For Every N", "Show every Nth jump: 2 to 50.")),
      group("Strafe trainer",
        toggle("Strafe trainer", "strafeTrainer", "Turn rate", "While you're in the air: how fast you turned against the turn rate that gains the most speed at your speed. 100% is ideal; green is within 10%, amber within 25%."),
        number("Average over", "strafeTrainerSmoothing", 1, 50, 1, "1 = every tick", "How many air ticks each reading averages. 1 updates every tick with that tick alone; higher is steadier but slower to react.", "ticks"),
        toggle("Hints", "strafeTrainerHints", "Under the trainer", "Says what to fix over the last 0.3 s in the air: Less deadtime! (no single strafe key held), Strafe more! (turning too slowly) or Strafe less! (turning too fast)."))),
    advanced);
  // The soundtrack as the host reports it (state.music): what's playing, Skip, and whether it's available at all.
  const musicNote = h("p.nset-hint.nset-music-note");
  const musicNow = h("span.nset-hint.nset-music-now");
  const skip = h("button.btn", { type: "button", onclick: () => send({ type: "music", action: "next" }) }, "Skip ▸") as HTMLButtonElement;
  function musicRow(): HTMLElement {
    return row("Next track", h("div.btn-row", null, musicNow, skip), "", "Skips to the next track. The play / pause and previous / next controls also sit on the home and pause screens.", "music skip song next track now playing soundtrack ost");
  }
  function refreshMusic(): void {
    const music = state.music;
    const custom = state.settings.musicPack === "custom";
    musicNow.textContent = music?.title ? `${music.playing ? "" : "Paused · "}${music.title.replace(/\s*\((menu|game)\)\s*$/i, "")}` : "";
    skip.disabled = !music?.available;
    musicNote.textContent = !music
      ? ""
      : music.loading ? "Loading the soundtrack…"
      : music.available ? (custom ? "Playing your tracks from the bgm folder." : "bunnyhop.lol OST is included with the app. No download needed.")
      : music.status || (custom ? "No playable tracks in the bgm folder yet." : "The soundtrack isn't available in this build.");
  }

  const audio = h("div.nset-cols", null,
    group("Volume",
      number("Volume", "volume", 0, 1, .01, "0 to 1", "Master volume for sound effects and music."),
      toggle("Mute", "muted")),
    group("Packs",
      pack("Sound effects", "sfxPack", "bunnyhop.lol SFX",
        "Custom sounds come from the sound folder in your Bunnyhop Native data directory. Name a file after the cue it replaces, such as jump.wav; WAV, MP3, FLAC or Ogg all work. Cues you haven't supplied keep the bunnyhop.lol sound."),
      pack("Music", "musicPack", "bunnyhop.lol OST", "bunnyhop.lol OST is the game's own soundtrack, included with the app and played offline: every track in the menus, the game tracks in game. Custom plays WAV, MP3, FLAC or Ogg files from the bgm folder in your Bunnyhop Native data directory, in filename order."),
      musicRow(),
      musicNote));

  const discordState = h("span.nset-state");
  const discord = h("div.nset-cols", null,
    group("Rich Presence",
      toggle("Show on Discord", "discordRichPresence", "", "Shows what you're playing on your Discord profile. Needs the Discord desktop app running."),
      toggle("Show the map", "discordShowMap", "", "Off shows only that you're bunnyhopping, not where."),
      toggle("Privacy mode", "privacyMode", "Hides everything", "Turns presence and Join off without changing the switches above.")),
    group("Join",
      toggle("Let friends join", "discordJoin", "Public servers", "While you're on a public server, friends get a Join button on your Discord profile."),
      toggle("Include private lobbies", "discordJoinLobbies", "", "Also offer Join from a private lobby. Anyone who can see your profile could then get in.")));

  let capturing: string | null = null, appendBinding = false;
  const buttons = new Map<string, HTMLButtonElement[]>();
  const bindRow = (action: BindAction): HTMLElement => {
    const label = actionLabel(action);
    const button = h("button.bind", { type: "button", "aria-label": `${label} binding`, onclick: () => { capturing = action; appendBinding = false; refresh(); } });
    const add = h("button.link-btn", { type: "button", title: "Add another key", onclick: () => { capturing = action; appendBinding = true; refresh(); } }, "Add");
    const clear = h("button.link-btn", { type: "button", title: "Unbind", onclick: () => save({ binds: { [action]: [] } }) }, "Clear");
    buttons.set(action, [...(buttons.get(action) ?? []), button]);
    return row(label, h("div.nset-bind", null, button, add, clear), "", "Click, then press a key, mouse button or wheel direction. Escape cancels. Escape and F10 stay reserved. Up to four keys each.", `${label} ${action} key bind`);
  };
  const keys = h("div.nset-cols", null, ...BIND_GROUPS.map(item => item.title === "Practice"
    ? group(item.title, ...item.actions.map(bindRow), toggle("Teleport keeps speed", "practiceKeepVelocity", "", "On: a checkpoint teleport gives you back the speed you saved it with. Off: you arrive standing still."))
    : group(item.title, ...item.actions.map(bindRow))));
  const turnAdvanced = h("details.nset-advanced", null,
    h("summary", null, h("span", null, "Advanced: turnbind modifier"), h("small.nset-hint", null, "A second turn speed")),
    h("div.nset-advanced-body", null,
      h("div.nset-advanced-bar", null, h("span.nset-hint", null, "While Turn modifier is held, turnbinds use this speed instead: faster or slower, your choice.")),
      group("",
        bindRow("turnFast"),
        speed("Modifier yaw speed", "yawSpeedAlt", DEFAULT_YAW_SPEED_ALT, "While Turn modifier is held", "The speed Turn left / Turn right use while Turn modifier is held, in degrees per second. Set it above your yaw speed for a fast turn (170, 210 ...) or below it for a slow one."))));
  const mouseBody = h("div.nset-hud", null, mouse, turnAdvanced);

  const sections: Section[] = [
    { id: "mouse", title: "Mouse", body: mouseBody },
    { id: "display", title: "Display", body: display },
    { id: "hud", title: "HUD", body: hud },
    { id: "audio", title: "Audio", body: audio },
    { id: "keys", title: "Keys", body: keys },
    { id: "discord", title: "Discord", body: discord },
  ];

  const scroll = h("div.nset-scroll", { tabindex: "-1" });
  const rail = h("nav.nset-rail", { "aria-label": "Settings sections" });
  const railItems = new Map<string, HTMLButtonElement>();
  const mark = (id: string): void => {
    for (const [key, item] of railItems) { item.classList.toggle("on", key === id); item.setAttribute("aria-current", key === id ? "true" : "false"); }
  };
  for (const section of sections) {
    const el = h("section.nset-sec", { id: `nset-${section.id}`, "aria-labelledby": `nset-${section.id}-h` },
      h("div.nset-sec-head", null, h("h2", { id: `nset-${section.id}-h` }, section.title), section.id === "discord" ? discordState : null), section.body);
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

  // ---- search ---------------------------------------------------------------
  // Filters rows across every section by name, hint and help text. A group or
  // section whose title matches keeps all its rows. Ctrl+F or / focuses it.
  const search = h("input.nset-search", { type: "search", placeholder: "Search settings", "aria-label": "Search settings", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const empty = h("p.nset-empty", { hidden: true }, "No settings match.");
  scroll.append(empty);
  function filter(): void {
    const query = search.value.trim().toLowerCase();
    let anyShown = false;
    for (const section of sections) {
      const el = document.getElementById(`nset-${section.id}`); if (!el) continue;
      const sectionHit = !!query && section.title.toLowerCase().includes(query);
      let sectionShown = false;
      for (const groupEl of el.querySelectorAll<HTMLElement>(".nset-group")) {
        const groupHit = sectionHit || (!!query && (groupEl.querySelector(".nset-group-title")?.textContent ?? "").toLowerCase().includes(query));
        let groupShown = false;
        for (const rowEl of groupEl.querySelectorAll<HTMLElement>(".nset-row")) {
          const shown = !query || groupHit || (rowEl.dataset.search ?? "").includes(query);
          rowEl.hidden = !shown; groupShown ||= shown;
        }
        groupEl.hidden = !groupShown; sectionShown ||= groupShown;
      }
      for (const details of el.querySelectorAll<HTMLDetailsElement>("details")) {
        const visible = [...details.querySelectorAll<HTMLElement>(".nset-row")].some(rowEl => !rowEl.hidden);
        details.hidden = !visible;
        if (query && visible) details.open = true;
      }
      el.hidden = !sectionShown; anyShown ||= sectionShown;
      railItems.get(section.id)?.classList.toggle("dim", !sectionShown);
    }
    empty.hidden = anyShown;
    if (query) scroll.scrollTop = 0;
  }
  search.addEventListener("input", filter);
  search.addEventListener("keydown", event => { if (event.key === "Escape" && search.value) { search.value = ""; filter(); event.preventDefault(); event.stopPropagation(); } });

  const root = h("div.nset", null, h("div.nset-side", null, search, rail, saved), scroll, h("div.nset-foot", null, help, status));
  root.addEventListener("keydown", event => {
    if (capturing || document.activeElement === search) return;
    const editing = document.activeElement instanceof HTMLInputElement && document.activeElement.type !== "checkbox" && document.activeElement.type !== "range";
    if ((event.key === "f" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !editing)) { event.preventDefault(); search.focus(); search.select(); }
  });

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
    const presence = state.settings.privacyMode ? "disabled" : state.discord.state;
    discordState.textContent = state.settings.privacyMode ? "Privacy mode" : DISCORD_TEXT[presence];
    discordState.dataset.tone = DISCORD_TONE[presence]; discordState.title = state.discord.message;
    const presenceOff = !state.settings.discordRichPresence || state.settings.privacyMode;
    for (const key of ["discordShowMap", "discordJoin", "discordJoinLobbies"] as const) {
      const input = controls.get(key);
      const off = presenceOff || (key === "discordJoinLobbies" && !state.settings.discordJoin);
      if (input instanceof HTMLInputElement) { input.disabled = off; input.closest(".nset-row")?.classList.toggle("off", off); }
    }
    const off = (key: keyof NativeSettings, disabled: boolean): void => {
      const control = controls.get(key);
      if (control instanceof HTMLInputElement) control.disabled = disabled;
      else if (control) for (const button of control.querySelectorAll("button")) button.disabled = disabled;
      control?.closest(".nset-row")?.classList.toggle("off", disabled);
    };
    off("jumpStatsMode", !state.settings.jumpStats);
    off("jumpStatsInterval", !state.settings.jumpStats || state.settings.jumpStatsMode !== "interval");
    off("strafeTrainerSmoothing", !state.settings.strafeTrainer);
    off("strafeTrainerHints", !state.settings.strafeTrainer);
    refreshPositions();
    refreshMusic();
    const vertical = controls.get("verticalSensitivity");
    if (vertical instanceof HTMLInputElement) { vertical.disabled = !state.settings.separateVertical; vertical.closest(".nset-row")?.classList.toggle("off", vertical.disabled); }
    for (const sync of speedSyncs) sync();
    for (const [action, list] of buttons) for (const button of list) {
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
    const moved = Object.keys(patch).filter(other => other !== action).map(actionLabel);
    if (moved.length) say(`${keyLabel(code)} moved from ${moved.join(", ")}.`);
    refresh();
  };
  for (const name of ["keydown", "mousedown", "wheel"]) root.addEventListener(name, capture, { capture: true, passive: false });

  const onState = (): void => { if (!root.isConnected) { window.removeEventListener("bunnyhop:host-state", onState); return; } refresh(); };
  window.addEventListener("bunnyhop:host-state", onState);
  refresh();
  return root;
}
