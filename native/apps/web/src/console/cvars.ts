// Console variables (console/): Source cvar names over the settings store (ui/settings.ts Prefs), so `fps_max 300` in
// the console or a pasted config.cfg changes the same setting as the Settings page. Source's own names where the
// setting is Source's (sensitivity, m_yaw, fps_max, fov_desired, cl_showfps, cl_crosshair*, viewmodel_*, snd_*...),
// `cl_` / `hud_` / `r_` / `snd_` names in the same spirit for this game's own. Older names stay as aliases.
// Client settings only: nothing here reaches the simulation, a room, the server or the anticheat. DOM-free.

import { ANGLE_SPEED_KEY_RANGE, YAW_SPEED_RANGE } from "../turn-binds";
import { M_YAW_RANGE, SENS_RANGE, sensProblem } from "../sens-convert";
import { HUD_ELEMENTS, HUD_SCALE, type HudElId } from "../hud/layout";
import { COLOR_BLIND_MODES } from "../palette";
import { KINDS, TRIGGER_OPACITY, TRIGGER_STYLES, TRIGGER_THICKNESS } from "../triggers/volumes";
import { JHUD_BANDS } from "../ssj/jhud";
import { PAINT_COLORS } from "../paint/prefs";
import { LANDING_MODES } from "../landing/prefs";
import { applyGraphicsPreset, DEFAULT_PREFS, graphicsPreset, PRESET_ORDER, type GraphicsPreset, type Prefs } from "../ui/settings";

export type CvarValue = number | string;

export interface Cvar {
  name: string;
  /** One short sentence (`help <cvar>`, `find`). */
  help: string;
  /** Other names typed for it (`maxfps`, the old bh_ names). */
  aliases?: readonly string[];
  /** 0 / 1 switch. */
  bool?: boolean;
  /** Allowed values (inclusive), unless `zero` is set and the value is 0 (fps_max 0: no limit). */
  range?: readonly [number, number];
  zero?: boolean;
  int?: boolean;
  /** A choice: one of these names (a number picks by position, as Source's numbered cvars). */
  values?: readonly string[];
  /** A colour, "#rrggbb" (also "rrggbb" or three 0-255 numbers). */
  color?: boolean;
  /** Worked out from other settings (crosshair, cl_crosshairdot, r_quality...): a written config leaves it out. */
  derived?: boolean;
  /** A written config leaves it out for these prefs (m_dpi while the DPI is the calculator's default). */
  skipWrite?(p: Prefs): boolean;
  get(p: Prefs): CvarValue;
  set(p: Prefs, v: CvarValue): void;
  /** Why `v` can't be set with these prefs (beyond the range), or null. */
  check?(p: Prefs, v: CvarValue): string | null;
}

const b = (v: boolean) => (v ? 1 : 0);
const pct: readonly [number, number] = [0, 1];
const n = (v: CvarValue) => Number(v);
const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
const channel = (color: string, i: number) => parseInt(color.slice(1 + i * 2, 3 + i * 2), 16) || 0;
const withChannel = (color: string, i: number, v: number) => "#" + [0, 1, 2].map((k) => (k === i ? hex2(v) : color.slice(1 + k * 2, 3 + k * 2))).join("");

/** A switch over a boolean pref. */
const sw = (name: string, help: string, get: (p: Prefs) => boolean, set: (p: Prefs, v: boolean) => void, aliases?: string[]): Cvar => ({ name, help, bool: true, aliases, get: (p) => b(get(p)), set: (p, v) => set(p, !!n(v)) });
/** A number over a numeric pref. */
const num = (name: string, help: string, range: readonly [number, number], get: (p: Prefs) => number, set: (p: Prefs, v: number) => void, o: Partial<Cvar> = {}): Cvar => ({ name, help, range, get, set: (p, v) => set(p, n(v)), ...o });
/** A choice over a string pref. */
const pick = <T extends string>(name: string, help: string, values: readonly T[], get: (p: Prefs) => T, set: (p: Prefs, v: T) => void, o: Partial<Cvar> = {}): Cvar => ({ name, help, values, get, set: (p, v) => set(p, v as T), ...o });

/** HUD elements as hud_<id> switches (cl_showfps is the FPS counter's Source name). */
const HUD_NAMES: Partial<Record<HudElId, { name: string; aliases?: string[] }>> = {
  fps: { name: "cl_showfps" },
  keys: { name: "hud_keys", aliases: ["bh_keys"] },
  strafeTrainer: { name: "hud_trainer", aliases: ["bh_trainer", "hud_strafetrainer"] },
  map: { name: "hud_mapline" },
};
const hudCvars: Cvar[] = HUD_ELEMENTS.map(({ id, label }) => {
  const o = HUD_NAMES[id] ?? { name: `hud_${id.toLowerCase()}` };
  return sw(o.name, `${label} on the HUD.`, (p) => p.hud.layout[id].on, (p, v) => (p.hud.layout[id].on = v), o.aliases);
});

const CROSSHAIR_STYLES = ["cross", "cross-dot", "dot", "t", "circle", "none"] as const;
/** A colour cvar over a "#rrggbb" pref. */
const col = (name: string, help: string, get: (p: Prefs) => string, set: (p: Prefs, v: string) => void): Cvar => ({ name, help, color: true, get, set: (p, v) => set(p, String(v)) });
const SSJ_FIELDS = ["speed", "diff", "gain", "sync", "strafes", "eff", "height", "time"] as const;
const LINES = ["off", "perfect", "godlike", "holyshit"] as const;
const ANNOUNCED = ["pb", "wr", "speed", "highSpeed", "streak", "lj"] as const;
const BUSES = ["music", "sfx", "ui", "ambience", "map"] as const;
/** The trainer, keys overlay, jump stats, JHUD and longjump settings (Settings → HUD). */
const hudDetail: Cvar[] = [
  pick("hud_trainer_style", "Strafe trainer look: classic, detailed, minimal or bar.", ["classic", "detailed", "minimal", "bar"] as const, (p) => p.hud.strafeTrainer.style, (p, v) => (p.hud.strafeTrainer.style = v)),
  col("hud_trainer_color", "Strafe trainer colour.", (p) => p.hud.strafeTrainer.color, (p, v) => (p.hud.strafeTrainer.color = v)),
  sw("hud_trainer_follow", "100% in the middle, moving the way you turn.", (p) => p.hud.strafeTrainer.follow, (p, v) => (p.hud.strafeTrainer.follow = v)),
  num("hud_trainer_smoothing", "Ticks averaged into the trainer, 1 to 20.", [1, 20], (p) => p.hud.strafeTrainer.smoothing, (p, v) => (p.hud.strafeTrainer.smoothing = v), { int: true }),
  num("hud_trainer_zone", "± % that counts as on pace, 2 to 30.", [2, 30], (p) => p.hud.strafeTrainer.zone, (p, v) => (p.hud.strafeTrainer.zone = v)),
  num("hud_trainer_height", "Trainer thickness, 0.5 to 3.", [0.5, 3], (p) => p.hud.strafeTrainer.height, (p, v) => (p.hud.strafeTrainer.height = v)),
  num("hud_trainer_dimbelow", "The trainer fades under this pace %, 0 to 90.", [0, 90], (p) => p.hud.strafeTrainer.dimBelow, (p, v) => (p.hud.strafeTrainer.dimBelow = v)),
  sw("hud_trainer_pace", "The pace number on the trainer.", (p) => p.hud.strafeTrainer.showPace, (p, v) => (p.hud.strafeTrainer.showPace = v)),
  sw("hud_trainer_hints", "Short hints under the trainer.", (p) => p.hud.strafeTrainer.hints, (p, v) => (p.hud.strafeTrainer.hints = v)),
  sw("hud_trainer_sound", "A tick on each jump, pitched by its zone.", (p) => p.hud.strafeTrainer.sound, (p, v) => (p.hud.strafeTrainer.sound = v)),
  pick("hud_keys_style", "Keys overlay look: classic, keycaps or minimal.", ["classic", "keycaps", "minimal"] as const, (p) => p.hud.keys.style, (p, v) => (p.hud.keys.style = v)),
  num("hud_keys_opacity", "Keys overlay opacity, 0.1 to 1.", [0.1, 1], (p) => p.hud.keys.opacity, (p, v) => (p.hud.keys.opacity = v)),
  col("hud_keys_pressed", "Keys overlay colour of a held key.", (p) => p.hud.keys.pressed, (p, v) => (p.hud.keys.pressed = v)),
  col("hud_keys_idle", "Keys overlay colour of a key not held.", (p) => p.hud.keys.idle, (p, v) => (p.hud.keys.idle = v)),
  ...(["wasd", "actions", "mouse"] as const).map((r) => sw(`hud_keys_${r}`, `The keys overlay's ${r} row.`, (p) => p.hud.keys.rows[r], (p, v) => (p.hud.keys.rows[r] = v))),
  sw("cl_ssj", "Jump stats in the chat (!ssj).", (p) => p.hud.ssj.chat, (p, v) => (p.hud.ssj.chat = v)),
  pick("cl_ssj_mode", "Which jumps: sixth, every or everysixth.", ["sixth", "every", "everysixth"] as const, (p) => (p.hud.ssj.mode === "everySixth" ? "everysixth" : p.hud.ssj.mode) as "sixth", (p, v) => (p.hud.ssj.mode = v === "everysixth" ? "everySixth" : (v as "sixth" | "every"))),
  num("cl_ssj_mingain", "Only report jumps with this gain % or more, 0 to 100.", [0, 100], (p) => p.hud.ssj.minGain, (p, v) => (p.hud.ssj.minGain = v), { int: true }),
  ...SSJ_FIELDS.map((f) => sw(`cl_ssj_${f}`, `Jump stats show ${f}.`, (p) => p.hud.ssj.fields[f], (p, v) => (p.hud.ssj.fields[f] = v))),
  sw("hud_jhud_sync", "JHUD shows sync.", (p) => p.hud.jhud.sync, (p, v) => (p.hud.jhud.sync = v)),
  sw("hud_jhud_jss", "JHUD shows JSS.", (p) => p.hud.jhud.jss, (p, v) => (p.hud.jhud.jss = v)),
  sw("hud_jhud_analyzer", "JHUD's turning too fast / slow arrow.", (p) => p.hud.jhud.analyzer, (p, v) => (p.hud.jhud.analyzer = v)),
  num("hud_jhud_speedcolors", "JHUD jumps coloured by speed, 1 to 16.", [1, 16], (p) => p.hud.jhud.speedColors, (p, v) => (p.hud.jhud.speedColors = v), { int: true }),
  num("hud_jhud_cutoff", "JHUD stops after this jump (0: never), 0 to 30.", [0, 30], (p) => p.hud.jhud.cutoff, (p, v) => (p.hud.jhud.cutoff = v), { int: true }),
  ...JHUD_BANDS.map((band) => col(`hud_jhud_color_${band.toLowerCase()}`, `JHUD colour for ${band}.`, (p) => p.hud.jhud.colors[band], (p, v) => (p.hud.jhud.colors[band] = v))),
  sw("cl_fjt_chat", "First jump tick in the chat.", (p) => p.hud.movement.fjtChat, (p, v) => (p.hud.movement.fjtChat = v)),
  sw("cl_ljstats", "Longjump stats.", (p) => p.hud.movement.lj, (p, v) => (p.hud.movement.lj = v)),
  sw("cl_ljstats_chat", "Longjump stats in the chat.", (p) => p.hud.movement.ljChat, (p, v) => (p.hud.movement.ljChat = v)),
];
/** Announcer, scroll-hop cues and per-bus mutes (Settings → Audio). */
const audioDetail: Cvar[] = [
  num("snd_announcer_volume", "Announcer volume, 0 to 1.", pct, (p) => p.audio.announcer.volume, (p, v) => (p.audio.announcer.volume = v)),
  ...(["finish", "movement", "local", "server"] as const).map((k) => sw(`snd_announcer_${k}`, `Announcer: ${k} events.`, (p) => p.audio.announcer[k], (p, v) => (p.audio.announcer[k] = v))),
  ...ANNOUNCED.map((k) => pick(`snd_announcer_${k.toLowerCase()}`, `The ${k} line: off, perfect, godlike or holyshit.`, LINES, (p) => p.audio.announcer[k], (p, v) => (p.audio.announcer[k] = v))),
  num("snd_announcer_speed_at", "Speed line at this speed, u/s.", [500, 10000], (p) => p.audio.announcer.speedThreshold, (p, v) => (p.audio.announcer.speedThreshold = v)),
  num("snd_announcer_highspeed_at", "High speed line at this speed, u/s.", [500, 10000], (p) => p.audio.announcer.highSpeedThreshold, (p, v) => (p.audio.announcer.highSpeedThreshold = v)),
  num("snd_announcer_streak_at", "Perfect streak line after this many hops.", [2, 20], (p) => p.audio.announcer.streakThreshold, (p, v) => (p.audio.announcer.streakThreshold = v), { int: true }),
  num("snd_announcer_lj_at", "Longjump line from this distance.", [200, 1000], (p) => p.audio.announcer.ljThreshold, (p, v) => (p.audio.announcer.ljThreshold = v)),
  sw("hud_perf", "Perf% beside Sync% in the scroll styles.", (p) => p.audio.perfHud, (p, v) => (p.audio.perfHud = v)),
  sw("hud_perfect", "Perfect text after a one-tick hop.", (p) => p.audio.perfectIndicator, (p, v) => (p.audio.perfectIndicator = v)),
  sw("snd_perfecttick", "A quiet tick on a perfect hop.", (p) => p.audio.perfectTick, (p, v) => (p.audio.perfectTick = v)),
  ...BUSES.map((k) => sw(`snd_mute_${k}`, `Mute ${k === "sfx" ? "game sounds" : k}.`, (p) => p.audio.mute[k], (p, v) => (p.audio.mute[k] = v))),
];
/** Ghost routes, trigger kinds and colours, paint, inspect, the look's extra switches. */
const otherDetail: Cvar[] = [
  sw("cl_ghost_route", "The selected ghost's route and takeoff marks.", (p) => p.ghost.route, (p, v) => (p.ghost.route = v)),
  sw("cl_ghost_routeonly", "Hide the route ghost while keeping its route and takeoff marks.", (p) => p.ghost.routeOnly, (p, v) => (p.ghost.routeOnly = v)),
  pick("cl_ghost_routesource", "Whose route: auto, pb, wr or custom.", ["auto", "pb", "wr", "custom"] as const, (p) => p.ghost.routeSource, (p, v) => (p.ghost.routeSource = v)),
  pick("cl_ghost_routemode", "Route as jumps or path.", ["jumps", "path"] as const, (p) => p.ghost.routeMode, (p, v) => (p.ghost.routeMode = v)),
  pick("cl_ghost_compare", "The ghost the split compares with: auto, pb, wr or custom.", ["auto", "pb", "wr", "custom"] as const, (p) => p.ghost.compare, (p, v) => (p.ghost.compare = v)),
  sw("cl_ghost_nearfade", "Fade a ghost when the camera is in it.", (p) => p.ghost.nearFade, (p, v) => (p.ghost.nearFade = v)),
  sw("cl_firstpersonglow", "Your glow on your hands and knife.", (p) => p.firstPersonGlow, (p, v) => (p.firstPersonGlow = v)),
  num("cl_triggerthickness", "Trigger line width, pixels.", TRIGGER_THICKNESS, (p) => p.triggers.thickness, (p, v) => (p.triggers.thickness = v)),
  ...KINDS.map((k) => sw(`cl_trigger_${k.id}`, `Show ${k.id} triggers.`, (p) => p.triggers.kinds[k.id], (p, v) => (p.triggers.kinds[k.id] = v))),
  ...KINDS.map((k) => col(`cl_trigger_color_${k.id}`, `Colour of ${k.id} triggers.`, (p) => p.triggers.colors[k.id], (p, v) => (p.triggers.colors[k.id] = v))),
  pick("cl_paint_color", `Paint colour: ${PAINT_COLORS.map(([, n]) => n.toLowerCase()).join(", ")}.`, PAINT_COLORS.map(([, n]) => n.toLowerCase()), (p) => (PAINT_COLORS.find(([c]) => c === p.paint.color)?.[1] ?? "Red").toLowerCase(), (p, v) => (p.paint.color = PAINT_COLORS.find(([, n]) => n.toLowerCase() === v)?.[0] ?? p.paint.color)),
  pick("cl_paint_size", "Paint size: small, medium or large.", ["small", "medium", "large"] as const, (p) => p.paint.size, (p, v) => (p.paint.size = v)),
  pick("cl_inspect", "The inspect key: tricks or quiet.", ["tricks", "quiet"] as const, (p) => p.viewmodel.inspect, (p, v) => (p.viewmodel.inspect = v)),
  sw("r_mapprofiles", "Map visual profiles (Enhanced, Cinematic).", (p) => p.graphics.mapProfiles, (p, v) => (p.graphics.mapProfiles = v)),
  sw("r_materialresponse", "Material response (Enhanced, Cinematic).", (p) => p.graphics.materialResponse, (p, v) => (p.graphics.materialResponse = v)),
  sw("r_spatialaa", "Spatial antialiasing (Enhanced, Cinematic).", (p) => p.graphics.spatialAA, (p, v) => (p.graphics.spatialAA = v)),
  sw("r_contactshading", "Contact shading (Enhanced, Cinematic).", (p) => p.graphics.contactShading, (p, v) => (p.graphics.contactShading = v)),
  sw("r_atmosphere", "Atmosphere (Enhanced, Cinematic).", (p) => p.graphics.atmosphere, (p, v) => (p.graphics.atmosphere = v)),
  sw("r_sunshafts", "Sun shafts (Enhanced, Cinematic).", (p) => p.graphics.sunShafts, (p, v) => (p.graphics.sunShafts = v)),
  sw("r_volumetric", "Volumetric light (Enhanced, Cinematic).", (p) => p.graphics.volumetric, (p, v) => (p.graphics.volumetric = v)),
  sw("r_clouds", "Clouds (Enhanced, Cinematic).", (p) => p.graphics.clouds, (p, v) => (p.graphics.clouds = v)),
  sw("r_locallights", "Local lights (Enhanced, Cinematic).", (p) => p.graphics.localLights, (p, v) => (p.graphics.localLights = v)),
  sw("r_dynamicgi", "Dynamic GI (Enhanced, Cinematic).", (p) => p.graphics.dynamicGI, (p, v) => (p.graphics.dynamicGI = v)),
  sw("r_tracedgi", "Traced GI (Cinematic).", (p) => p.graphics.tracedGI, (p, v) => (p.graphics.tracedGI = v)),
  pick("r_shadowquality", "Shadow quality: low, medium or high.", ["low", "medium", "high"] as const, (p) => p.graphics.shadowQuality, (p, v) => (p.graphics.shadowQuality = v)),
  pick("r_cloudquality", "Cloud quality: low, medium or high.", ["low", "medium", "high"] as const, (p) => p.graphics.cloudQuality, (p, v) => (p.graphics.cloudQuality = v)),
  pick("r_localquality", "Local light quality: low, medium or high.", ["low", "medium", "high"] as const, (p) => p.graphics.localQuality, (p, v) => (p.graphics.localQuality = v)),
  pick("r_giquality", "GI quality: low or medium.", ["low", "medium"] as const, (p) => p.graphics.giQuality, (p, v) => (p.graphics.giQuality = v)),
];

export const CVARS: readonly Cvar[] = [
  // ---- mouse (Source's names)
  num("sensitivity", "Mouse sensitivity. Degrees per count = sensitivity × m_yaw.", SENS_RANGE, (p) => p.sensitivity, (p, v) => (p.sensitivity = v), { check: (p, v) => sensProblem(n(v), p.mYaw) }),
  num("m_yaw", "Degrees per count at sensitivity 1 (CS:S 0.022).", M_YAW_RANGE, (p) => p.mYaw, (p, v) => (p.mYaw = v), { check: (p, v) => sensProblem(p.sensitivity, n(v)) }),
  num("m_pitch", "The same for looking up and down. Negative inverts mouse Y.", [-M_YAW_RANGE[1], M_YAW_RANGE[1]], (p) => (p.invertY ? -p.mPitch : p.mPitch), (p, v) => ((p.invertY = v < 0), (p.mPitch = Math.abs(v))), {
    check: (_p, v) => (Math.abs(n(v)) < M_YAW_RANGE[0] ? `m_pitch can't be smaller than ${M_YAW_RANGE[0]} (or -${M_YAW_RANGE[0]}).` : null),
  }),
  sw("m_rawinput", "Raw mouse input (no OS acceleration), from the next click into the game.", (p) => p.rawInput, (p, v) => (p.rawInput = v)),
  num("m_vsens", "Vertical sensitivity (used while m_vsens_on is 1).", SENS_RANGE, (p) => p.verticalSensitivity, (p, v) => (p.verticalSensitivity = v), { aliases: ["bh_vsens"] }),
  sw("m_vsens_on", "Use m_vsens for looking up and down.", (p) => p.verticalSensitivityEnabled, (p, v) => (p.verticalSensitivityEnabled = v), ["bh_vsens_on"]),
  num("m_dpi", "Your mouse's DPI, for cm/360 and eDPI.", [50, 32000], (p) => p.dpi, (p, v) => ((p.dpi = v), (p.dpiConfirmed = true)), { int: true, aliases: ["bh_dpi"], skipWrite: (p) => !p.dpiConfirmed }),
  sw("m_dpi_hidden", "Keep your DPI off your profile.", (p) => p.dpiHidden, (p, v) => (p.dpiHidden = v)),
  sw("m_spikefilter", "Drop impossible mouse jumps.", (p) => p.spikeFilter, (p, v) => (p.spikeFilter = v), ["bh_spikefilter"]),
  sw("m_timedinput", "Timestamped input: each tick takes the input made before it.", (p) => p.timedInput, (p, v) => (p.timedInput = v), ["bh_timedinput"]),
  sw("cl_inputstats", "Input diagnostics overlay.", (p) => p.inputStats, (p, v) => (p.inputStats = v), ["bh_inputstats"]),
  // ---- keys
  num("cl_yawspeed", "+left / +right turn speed, degrees per second. From your next restart.", YAW_SPEED_RANGE, (p) => p.yawSpeed, (p, v) => (p.yawSpeed = v)),
  num("cl_anglespeedkey", "Turn speed multiplier while +speed is held.", ANGLE_SPEED_KEY_RANGE, (p) => p.angleSpeedKey, (p, v) => (p.angleSpeedKey = v)),
  sw("cl_nullbinds", "Null binds: with A and D held, the last one pressed wins.", (p) => p.nullBinds, (p, v) => (p.nullBinds = v), ["bh_nullbinds"]),
  sw("cl_wrelease", "Release W on jump.", (p) => p.wRelease, (p, v) => (p.wRelease = v), ["bh_wrelease"]),
  sw("cl_holdrestart", "Restart keys need a short hold.", (p) => p.holdRestart, (p, v) => (p.holdRestart = v), ["bh_holdrestart"]),
  pick("cl_autorestart", "Restart a timed run once it's past: off, pb, wr or ghost.", ["off", "pb", "wr", "ghost"] as const, (p) => p.autoRestart.when, (p, v) => (p.autoRestart.when = v)),
  pick("cl_autorestart_action", "What auto restart does: restart or sound.", ["restart", "sound"] as const, (p) => p.autoRestart.action, (p, v) => (p.autoRestart.action = v)),
  sw("cl_cp_keepvelocity", "A checkpoint teleport keeps the speed you saved it with.", (p) => p.practice.keepVelocity, (p, v) => (p.practice.keepVelocity = v)),
  // ---- view
  num("fov_desired", "Field of view, horizontal at 4:3.", [75, 120], (p) => p.fov, (p, v) => (p.fov = v)),
  num("viewmodel_fov", "Viewmodel field of view.", [40, 90], (p) => p.viewmodel.fov, (p, v) => (p.viewmodel.fov = v)),
  num("viewmodel_offset_x", "Viewmodel offset right.", [-2, 2.5], (p) => p.viewmodel.x, (p, v) => (p.viewmodel.x = v)),
  num("viewmodel_offset_y", "Viewmodel offset forward.", [-2, 2], (p) => p.viewmodel.y, (p, v) => (p.viewmodel.y = v)),
  num("viewmodel_offset_z", "Viewmodel offset up.", [-2, 2], (p) => p.viewmodel.z, (p, v) => (p.viewmodel.z = v)),
  num("viewmodel_bob", "Viewmodel bob, 0 to 1.5 (1 = CS:S).", [0, 1.5], (p) => p.viewmodel.bob, (p, v) => (p.viewmodel.bob = v)),
  num("viewmodel_sway", "Viewmodel sway, 0 to 1.5 (1 = CS:S).", [0, 1.5], (p) => p.viewmodel.sway, (p, v) => (p.viewmodel.sway = v)),
  sw("r_drawviewmodel", "Show the viewmodel.", (p) => p.viewmodel.show, (p, v) => (p.viewmodel.show = v)),
  sw("cl_righthand", "Viewmodel in the right hand (0: left).", (p) => p.viewmodel.hand === "right", (p, v) => (p.viewmodel.hand = v ? "right" : "left")),
  sw("cl_landsettle", "A short camera settle after a hard landing.", (p) => p.viewmodel.landSettle, (p, v) => (p.viewmodel.landSettle = v)),
  sw("cl_speedfov", "A tiny FOV ease at bhop speeds.", (p) => p.viewmodel.speedFov, (p, v) => (p.viewmodel.speedFov = v)),
  // ---- crosshair (cl_crosshair* names; sizes in pixels, alpha 0-255 as in CS:GO)
  { name: "crosshair", help: "Show the crosshair.", bool: true, derived: true, get: (p) => b(p.crosshair.style !== "none"), set: (p, v) => (p.crosshair.style = n(v) ? (p.crosshair.style === "none" ? "cross" : p.crosshair.style) : "none") },
  pick("cl_crosshairstyle", "Crosshair shape: cross, cross-dot, dot, t, circle or none.", CROSSHAIR_STYLES, (p) => p.crosshair.style, (p, v) => (p.crosshair.style = v)),
  { name: "cl_crosshairdot", help: "A dot in the middle of the cross.", bool: true, derived: true, get: (p) => b(p.crosshair.style === "cross-dot" || p.crosshair.style === "dot"), set: (p, v) => (p.crosshair.style = n(v) ? (p.crosshair.style === "cross" ? "cross-dot" : p.crosshair.style === "none" ? "dot" : p.crosshair.style) : p.crosshair.style === "cross-dot" ? "cross" : p.crosshair.style === "dot" ? "none" : p.crosshair.style) },
  num("cl_crosshairsize", "Crosshair arm length, pixels.", [1, 20], (p) => p.crosshair.size, (p, v) => (p.crosshair.size = v), { aliases: ["bh_crosshair_size"] }),
  num("cl_crosshairthickness", "Crosshair arm width, pixels.", [1, 6], (p) => p.crosshair.thickness, (p, v) => (p.crosshair.thickness = v), { aliases: ["bh_crosshair_thickness"] }),
  num("cl_crosshairgap", "Crosshair gap, pixels.", [0, 16], (p) => p.crosshair.gap, (p, v) => (p.crosshair.gap = v), { aliases: ["bh_crosshair_gap"] }),
  num("cl_crosshairalpha", "Crosshair opacity, 51 to 255.", [51, 255], (p) => Math.round(p.crosshair.alpha * 255), (p, v) => (p.crosshair.alpha = Math.round((v / 255) * 1000) / 1000), { int: true }),
  { name: "bh_crosshair_alpha", help: "Crosshair opacity, 0.2 to 1 (cl_crosshairalpha in 0-255).", range: [0.2, 1], derived: true, get: (p) => p.crosshair.alpha, set: (p, v) => (p.crosshair.alpha = n(v)) },
  sw("cl_crosshair_drawoutline", "Dark outline round the crosshair.", (p) => p.crosshair.outline, (p, v) => (p.crosshair.outline = v), ["bh_crosshair_outline"]),
  { name: "cl_crosshaircolor", help: "Crosshair colour, #rrggbb.", color: true, get: (p) => p.crosshair.color, set: (p, v) => (p.crosshair.color = String(v)) },
  ...(["r", "g", "b"] as const).map((c, i): Cvar => ({ name: `cl_crosshaircolor_${c}`, help: `Crosshair colour's ${c === "r" ? "red" : c === "g" ? "green" : "blue"}, 0 to 255.`, range: [0, 255], int: true, derived: true, get: (p) => channel(p.crosshair.color, i), set: (p, v) => (p.crosshair.color = withChannel(p.crosshair.color, i, n(v))) })),
  // ---- HUD
  ...hudCvars,
  sw("net_graph", "FPS counter with your ping in servers.", (p) => p.hud.netGraph, (p, v) => ((p.hud.netGraph = v), v && (p.hud.layout.fps.on = true))),
  num("cl_showpos", "Position readout, top right: 1 eye and view angles, 2 feet.", [0, 2], (p) => p.hud.showPos, (p, v) => (p.hud.showPos = v), { int: true }),
  sw("cl_drawhud", "Draw the HUD in game (0 is Hide UI).", (p) => !p.hud.hidden, (p, v) => (p.hud.hidden = !v)),
  pick("hud_hiddenkeeps", "What Hide UI keeps: speedkeys or nothing.", ["speedkeys", "nothing"] as const, (p) => (p.hud.hiddenKeeps === "speedKeys" ? "speedkeys" : "nothing"), (p, v) => (p.hud.hiddenKeeps = v === "speedkeys" ? "speedKeys" : "nothing")),
  num("hud_scale", "HUD size, 0.5 to 1.75.", [HUD_SCALE.min, HUD_SCALE.max], (p) => p.hud.scale, (p, v) => (p.hud.scale = v), { aliases: ["bh_hud_scale"] }),
  sw("hud_speedcolors", "Speed turns green gaining, red losing.", (p) => p.hud.speedColors, (p, v) => (p.hud.speedColors = v), ["bh_speedcolors"]),
  sw("hud_gainticks", "Each jump's gain floats off the speed.", (p) => p.hud.gainTicks, (p, v) => (p.hud.gainTicks = v)),
  sw("hud_edgeglow", "The screen edges glow at high speed.", (p) => p.hud.edgeGlow, (p, v) => (p.hud.edgeGlow = v)),
  pick("hud_place", "Leaderboard place beside the split: off, place or top.", ["off", "place", "top"] as const, (p) => p.hud.place, (p, v) => (p.hud.place = v)),
  sw("cl_showzones", "Start and end zone boxes.", (p) => p.showZones, (p, v) => (p.showZones = v), ["bh_showzones"]),
  sw("cl_showtriggers", "Trigger outlines (!showtriggers).", (p) => p.triggers.show, (p, v) => (p.triggers.show = v)),
  sw("cl_showclips", "Player clips and invisible walls (!showclips).", (p) => p.triggers.clips, (p, v) => (p.triggers.clips = v)),
  pick("cl_triggerstyle", `How triggers draw: ${TRIGGER_STYLES.map(([s]) => s).join(", ")}.`, TRIGGER_STYLES.map(([s]) => s), (p) => p.triggers.style, (p, v) => (p.triggers.style = v)),
  num("cl_triggeropacity", "Trigger face opacity.", TRIGGER_OPACITY, (p) => p.triggers.opacity, (p, v) => (p.triggers.opacity = v)),
  pick("cl_landing", `Landing spot (!landing): ${LANDING_MODES.map(([m]) => m).join(", ")}.`, LANDING_MODES.map(([m]) => m), (p) => p.landing.mode, (p, v) => (p.landing.mode = v)),
  sw("cl_landing_path", "The landing spot's dotted path.", (p) => p.landing.arc, (p, v) => (p.landing.arc = v)),
  col("cl_landing_color", "Landing spot colour.", (p) => p.landing.color, (p, v) => (p.landing.color = v)),
  pick("cl_colorblind", `Colour-blind palette: ${COLOR_BLIND_MODES.map(([m]) => m).join(", ")}.`, COLOR_BLIND_MODES.map(([m]) => m), (p) => p.colorBlind, (p, v) => (p.colorBlind = v)),
  // ---- ghosts and players
  sw("cl_ghosts", "Race ghosts.", (p) => p.showGhost, (p, v) => (p.showGhost = v), ["bh_ghosts"]),
  sw("cl_ghost_pb", "Your PB ghost.", (p) => p.ghost.pb, (p, v) => (p.ghost.pb = v)),
  sw("cl_ghost_wr", "The WR ghost.", (p) => p.ghost.wr, (p, v) => (p.ghost.wr = v)),
  sw("cl_ghost_custom", "A loaded or chosen ghost.", (p) => p.ghost.custom, (p, v) => (p.ghost.custom = v)),
  num("cl_ghost_opacity", "Ghost opacity, 0.15 to 1.", [0.15, 1], (p) => p.ghost.opacity, (p, v) => (p.ghost.opacity = v)),
  sw("cl_ghost_trail", "A fading trail behind ghosts.", (p) => p.ghost.trail, (p, v) => (p.ghost.trail = v)),
  sw("cl_ghost_tag", "Name and time over ghosts.", (p) => p.ghost.tag, (p, v) => (p.ghost.tag = v)),
  sw("cl_showplayers", "Other players in servers.", (p) => p.showPlayers, (p, v) => (p.showPlayers = v), ["bh_showplayers"]),
  sw("cl_nametags", "Name tags over other players.", (p) => p.tags.players, (p, v) => (p.tags.players = v)),
  sw("cl_nametags_walls", "Name tags through walls.", (p) => p.tags.throughWalls, (p, v) => (p.tags.throughWalls = v)),
  sw("cl_playerglow", "Supporter glows on players.", (p) => p.showPlayerGlow, (p, v) => (p.showPlayerGlow = v)),
  // ---- graphics
  num("fps_max", "FPS limit while playing (0: none). Above your refresh rate needs r_uncapped 1.", [30, 1000], (p) => p.graphics.fpsLimit, (p, v) => (p.graphics.fpsLimit = v), { zero: true, int: true, aliases: ["maxfps"] }),
  num("fps_max_menu", "FPS limit in menus (0: the same as playing).", [10, 1000], (p) => p.graphics.menuFps, (p, v) => (p.graphics.menuFps = v), { zero: true, int: true }),
  sw("r_uncapped", "Exceed monitor FPS (an uncapped frame loop).", (p) => p.graphics.uncapped, (p, v) => (p.graphics.uncapped = v)),
  sw("r_lowlatency", "Low-latency canvas, after a reload.", (p) => p.graphics.lowLatency, (p, v) => (p.graphics.lowLatency = v)),
  pick("r_quality", "Quality preset: lowest, low, medium or high (custom when changed by hand).", PRESET_ORDER, (p) => (graphicsPreset(p.graphics) ?? "custom") as GraphicsPreset, (p, v) => applyGraphicsPreset(p.graphics, v), { derived: true }),
  pick("r_look", "Rendering look: source, classic, enhanced or cinematic.", ["source", "classic", "enhanced", "cinematic"] as const, (p) => p.graphics.preset as "source", (p, v) => (p.graphics.preset = v)),
  sw("r_potato", "Potato graphics.", (p) => p.graphics.potato, (p, v) => (p.graphics.potato = v), ["bh_potato"]),
  num("r_resolutionscale", "Render resolution, 0.25 to 2 of the screen's.", [0.25, 2], (p) => p.graphics.resolutionScale, (p, v) => (p.graphics.resolutionScale = v)),
  sw("mat_antialias", "Antialiasing, after a reload.", (p) => p.graphics.antialias, (p, v) => (p.graphics.antialias = v)),
  { name: "mat_forceaniso", help: "Texture filtering: 1, 2, 4, 8 or 16.", range: [1, 16], int: true, get: (p) => p.graphics.anisotropy, set: (p, v) => (p.graphics.anisotropy = n(v)), check: (_p, v) => ([1, 2, 4, 8, 16].includes(n(v)) ? null : "mat_forceaniso is 1, 2, 4, 8 or 16.") },
  sw("r_waterreflections", "Reflective water in the Source look.", (p) => p.graphics.waterReflections, (p, v) => (p.graphics.waterReflections = v)),
  sw("r_bloom", "Bloom.", (p) => p.graphics.bloom, (p, v) => (p.graphics.bloom = v)),
  sw("r_shadows", "Dynamic shadows (Enhanced, Cinematic).", (p) => p.graphics.dynamicShadows, (p, v) => (p.graphics.dynamicShadows = v)),
  sw("mat_fullbright", "Fullbright on every map without its own setting.", (p) => p.graphics.fullbright, (p, v) => (p.graphics.fullbright = v)),
  num("r_brightness", "Brightness, 0.5 to 2.", [0.5, 2], (p) => p.graphics.brightness, (p, v) => (p.graphics.brightness = v), { aliases: ["bh_brightness"] }),
  num("r_gamma", "Gamma, 0.5 to 2.5.", [0.5, 2.5], (p) => p.graphics.gamma, (p, v) => (p.graphics.gamma = v)),
  num("r_vibrance", "Colour vibrance, 0 to 2.", [0, 2], (p) => p.graphics.vibrance, (p, v) => (p.graphics.vibrance = v)),
  pick("r_aspect", "Aspect ratio: native, 4:3, 5:4, 16:10 or 16:9.", ["native", "4:3", "5:4", "16:10", "16:9"] as const, (p) => p.graphics.aspect, (p, v) => (p.graphics.aspect = v)),
  pick("r_aspectfit", "A fixed aspect ratio: stretch or bars.", ["stretch", "bars"] as const, (p) => p.graphics.aspectFit, (p, v) => (p.graphics.aspectFit = v)),
  sw("r_pixelated", "Sharp pixels when the resolution is lowered.", (p) => p.graphics.pixelated, (p, v) => (p.graphics.pixelated = v)),
  sw("r_fullscreen", "Go fullscreen when clicking into the game.", (p) => p.graphics.fullscreen, (p, v) => (p.graphics.fullscreen = v)),
  pick("r_menubackground", "Main menu background: live, still or off.", ["live", "still", "off"] as const, (p) => p.graphics.menuBackground, (p, v) => (p.graphics.menuBackground = v)),
  // ---- sound
  num("volume", "Master volume, 0 to 1.", pct, (p) => p.volume, (p, v) => (p.volume = v)),
  num("snd_musicvolume", "Music volume, 0 to 1.", pct, (p) => p.audio.music, (p, v) => (p.audio.music = v)),
  num("snd_sfxvolume", "Game sounds volume, 0 to 1.", pct, (p) => p.audio.sfx, (p, v) => (p.audio.sfx = v), { aliases: ["bh_sfxvolume"] }),
  num("snd_uivolume", "Menu sounds volume, 0 to 1.", pct, (p) => p.audio.ui, (p, v) => (p.audio.ui = v)),
  num("snd_ambiencevolume", "Ambience volume, 0 to 1.", pct, (p) => p.audio.ambience, (p, v) => (p.audio.ambience = v)),
  num("snd_mapvolume", "The map's own sounds, 0 to 1.", pct, (p) => p.audio.map, (p, v) => (p.audio.map = v)),
  sw("snd_mute", "Mute everything.", (p) => p.audio.muted, (p, v) => (p.audio.muted = v)),
  sw("snd_mute_losefocus", "Silence while the tab is in the background.", (p) => p.audio.muteInBackground, (p, v) => (p.audio.muteInBackground = v)),
  pick("snd_musicmode", "Music: always, menus or off.", ["always", "menus", "off"] as const, (p) => p.audio.musicMode, (p, v) => (p.audio.musicMode = v)),
  sw("snd_shuffle", "Shuffle the music.", (p) => p.audio.shuffle, (p, v) => (p.audio.shuffle = v)),
  sw("snd_classic", "The original CS:S footsteps and landings where available.", (p) => p.audio.classic, (p, v) => (p.audio.classic = v)),
  sw("snd_footsteps", "Footsteps.", (p) => p.audio.footsteps, (p, v) => (p.audio.footsteps = v)),
  sw("snd_wind", "Wind that rises with speed.", (p) => p.audio.wind, (p, v) => (p.audio.wind = v)),
  sw("snd_others", "Other players' sounds in servers.", (p) => p.audio.others, (p, v) => (p.audio.others = v)),
  sw("snd_ghosts", "Ghost sounds.", (p) => p.audio.ghosts, (p, v) => (p.audio.ghosts = v)),
  sw("snd_announcer", "The announcer.", (p) => p.audio.announcer.enabled, (p, v) => (p.audio.announcer.enabled = v)),
  ...hudDetail,
  ...audioDetail,
  ...otherDetail,
];

/**
 * Settings with no console variable, and why (apps/web/test/cvar-audit.test.ts checks every setting is a cvar or
 * here). Prefixes match whole subtrees.
 */
export const NOT_CONSOLE: Readonly<Record<string, string>> = {
  binds: "keys: bind / unbind",
  cmdBinds: "keys: bind",
  aliases: "alias",
  mapLooks: "per map: !bright, !fb, the pause menu",
  "hud.layout": "positions and sizes: the HUD editor (on / off: hud_*)",
  "graphics.lightingProfile": "a picker with previews: Settings → Graphics",
  "graphics.skyMode": "a picker with previews: Settings → Graphics",
  "graphics.skyPackId": "a picker with previews: Settings → Graphics",
  "graphics.skyRotation": "fine look sliders: Settings → Graphics",
  "graphics.skyExposure": "fine look sliders: Settings → Graphics",
  "graphics.lightingSource": "a picker with previews: Settings → Graphics",
  "graphics.directContribution": "fine look sliders: Settings → Graphics",
  "graphics.ambientContribution": "fine look sliders: Settings → Graphics",
  "graphics.cloudCoverage": "fine look sliders: Settings → Graphics",
  "graphics.cloudDensity": "fine look sliders: Settings → Graphics",
  "graphics.localBudget": "fine look sliders: Settings → Graphics",
  "graphics.localStrength": "fine look sliders: Settings → Graphics",
  "graphics.giStrength": "fine look sliders: Settings → Graphics",
  "graphics.giRange": "fine look sliders: Settings → Graphics",
  "graphics.shadowDistance": "fine look sliders: Settings → Graphics",
  "graphics.shadowStrength": "fine look sliders: Settings → Graphics",
  "graphics.ambienceShowcase": "a showcase mode for the menu: Settings → Graphics",
  "graphics.flashlight": "this session only: the flashlight key (impulse 100)",
  dpiConfirmed: "set with m_dpi",
  "viewmodel.rev": "internal (settings migration)",
  "audio.rev": "internal (settings migration)",
  mouseNames: "internal (settings migration)",
  bonusBindRevision: "internal (settings migration)",
};

const BY_NAME = new Map<string, Cvar>();
for (const c of CVARS) for (const name of [c.name, ...(c.aliases ?? [])]) BY_NAME.set(name, c);

/** A cvar by name or alias (any case). */
export const findCvar = (name: string): Cvar | undefined => BY_NAME.get(name.toLowerCase());

/** The value as the console prints it: names for choices, 0 / 1 for switches, numbers without float noise. */
export const fmtCvar = (v: CvarValue): string => (typeof v === "string" ? v : String(Number(v.toPrecision(10))));

/** A cvar's default (from DEFAULT_PREFS). */
export const cvarDefault = (c: Cvar): CvarValue => c.get(DEFAULT_PREFS);

/** Source's line for a cvar: `"sensitivity" = "2" ( def. "2" )`. */
export const describeCvar = (c: Cvar, p: Prefs): string => `"${c.name}" = "${fmtCvar(c.get(p))}" ( def. "${fmtCvar(cvarDefault(c))}" )`;

/** Reads a console number: a number, or on / off / true / false / yes / no for switches. NaN when it isn't one. */
export function readValue(raw: string, bool = false): number {
  const s = raw.trim().toLowerCase();
  if (bool && ["on", "true", "yes"].includes(s)) return 1;
  if (bool && ["off", "false", "no"].includes(s)) return 0;
  return s === "" ? NaN : Number(s);
}

/** "#rrggbb" from "#rrggbb", "rrggbb", "#rgb" or "r g b" (0-255), or null. */
export function parseColor(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  const m6 = /^#?([0-9a-f]{6})$/.exec(s);
  if (m6) return "#" + m6[1];
  const m3 = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m3) return "#" + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
  const rgb = s.split(/[\s,]+/).map(Number);
  if (rgb.length === 3 && rgb.every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) return "#" + rgb.map(hex2).join("");
  return null;
}

/** The value `raw` means for `c` (a name for a choice, a colour, a number), or why it isn't one. */
export function parseCvar(c: Cvar, raw: string): { value: CvarValue } | { error: string } {
  if (c.values) {
    const s = raw.trim().toLowerCase();
    const i = /^\d+$/.test(s) ? Number(s) : -1;
    const v = i >= 0 && i < c.values.length ? c.values[i] : c.values.find((x) => x.toLowerCase() === s);
    return v !== undefined ? { value: v } : { error: `${c.name} is one of: ${c.values.join(", ")}.` };
  }
  if (c.color) {
    const v = parseColor(raw);
    return v ? { value: v } : { error: `${c.name} takes a colour: #rrggbb, or three numbers 0-255.` };
  }
  const v = readValue(raw, c.bool);
  if (!Number.isFinite(v)) return { error: `${c.name} needs a number${c.bool ? " (0 or 1)" : ""}.` };
  if (c.bool) return { value: v ? 1 : 0 };
  if (c.range && !(c.zero && v === 0) && (v < c.range[0] || v > c.range[1])) return { error: `${c.name} goes from ${c.range[0]} to ${c.range[1]}${c.zero ? " (or 0)" : ""}.` };
  if (c.int && !Number.isInteger(v)) return { error: `${c.name} takes a whole number.` };
  return { value: v };
}

/**
 * Sets `c` from text in `p` (call inside prefs.update). Returns null when it was set, else why not (the value is
 * left alone). Switches take any number (0 is off), as Source's do.
 */
export function setCvar(p: Prefs, c: Cvar, raw: string): string | null {
  const r = parseCvar(c, raw);
  if ("error" in r) return r.error;
  const why = c.check?.(p, r.value);
  if (why) return why;
  c.set(p, r.value);
  return null;
}

/** The settings a written config (host_writeconfig) holds: every cvar not worked out from others. */
export const WRITTEN_CVARS: readonly Cvar[] = CVARS.filter((c) => !c.derived);

/**
 * Source cvars a CS:S / CS:GO config often has that don't apply here, with why (a config import lists them). Anything
 * else unknown is reported as unknown.
 */
export const UNSUPPORTED_CVARS: Record<string, string> = {
  m_customaccel: "no mouse acceleration here",
  m_customaccel_exponent: "no mouse acceleration here",
  m_customaccel_scale: "no mouse acceleration here",
  m_customaccel_max: "no mouse acceleration here",
  m_mouseaccel1: "no mouse acceleration here",
  m_mouseaccel2: "no mouse acceleration here",
  m_mousespeed: "no mouse acceleration here",
  m_filter: "no mouse smoothing here",
  m_forward: "fixed (keys only)",
  m_side: "fixed (keys only)",
  zoom_sensitivity_ratio: "not adjustable yet",
  zoom_sensitivity_ratio_mouse: "not adjustable yet",
  cl_forwardspeed: "fixed at 450 like CS:S",
  cl_sidespeed: "fixed at 450 like CS:S",
  cl_backspeed: "fixed at 450 like CS:S",
  cl_dynamiccrosshair: "the crosshair is always static",
  cl_crosshairscale: "use cl_crosshairsize",
  cl_crosshair_t: "use cl_crosshairstyle t",
  rate: "network settings are the server's",
  cl_cmdrate: "network settings are the server's",
  cl_updaterate: "network settings are the server's",
  cl_interp: "network settings are the server's",
  cl_interp_ratio: "network settings are the server's",
  cl_lagcompensation: "network settings are the server's",
  mat_monitorgamma: "use r_gamma (0.5 to 2.5)",
  mat_vsync: "use fps_max and r_uncapped",
  mat_queue_mode: "not a browser setting",
  r_dynamic: "not a browser setting",
  cl_bob: "use viewmodel_bob",
  cl_bobcycle: "use viewmodel_bob",
  cl_bobup: "use viewmodel_bob",
  cl_autowepswitch: "no weapon pickups",
  hud_fastswitch: "weapon slots always switch at once",
  voice_enable: "no voice chat",
  voice_scale: "no voice chat",
  snd_mixahead: "not a browser setting",
  windows_speaker_config: "not a browser setting",
  name: "change your name on your profile",
  con_enable: "the console is always on",
  developer: "not available",
  sv_cheats: "server settings aren't the client's",
};

/** True for a cvar name this client never sets: server, cheat and anticheat-side variables (sv_*, mp_*, sm_*). */
export const isServerCvar = (name: string): boolean => /^(sv|mp|sm|bot|tv|host)_/i.test(name) && name.toLowerCase() !== "host_writeconfig";
