// Every sound the game plays: id -> bus, mix level and voice rules. The files themselves (variants, durations) come
// from src/assets/audio/manifest.json (written by tools/audio/process.ts); ids missing there are silently skipped.

import type { BusId } from "./engine";

export type SfxId =
  // gameplay
  | "jump"
  | "land_soft"
  | "land_hard"
  | "step_concrete"
  | "step_metal"
  | "step_wood"
  | "step_grass"
  | "step_tile"
  | "step_water"
  | "wind"
  | "wind_high"
  | "teleport"
  | "boost"
  | "water_enter"
  | "water_exit"
  | "swim"
  // run feedback
  | "announcer_perfect"
  | "announcer_godlike"
  | "announcer_holyshit"
  | "start_beep"
  | "split"
  | "finish"
  | "finish_pb"
  | "finish_wr"
  | "rank_up"
  | "achievement"
  | "level_up"
  // UI
  | "ui_hover"
  | "ui_click"
  | "ui_confirm"
  | "ui_back"
  | "ui_toggle"
  | "ui_error"
  | "ui_card"
  | "ui_press"
  | "ui_land"
  | "ui_switch"
  | "ui_open"
  | "ui_close"
  | "countdown_tick"
  | "countdown_go"
  // notifications (notify/)
  | "toast_pop"
  | "count_tick"
  | "stamp"
  | "bunny_boing"
  | "shine"
  // rooms
  | "chat"
  | "supporter_gift"
  | "player_join"
  | "vote_open"
  | "vote_tick"
  | "map_change"
  // viewmodel
  | "carrot_swing"
  | "carrot_stab"
  | "carrot_draw"
  // weapons (physics v4): knife / bullet impacts by surface, map-given guns
  | "impact_metal"
  | "impact_wood"
  | "impact_concrete"
  | "impact_dirt"
  | "impact_tile"
  | "shot_pistol"
  | "shot_sniper"
  | "gun_draw"
  | "gun_thumper_fire"
  | "gun_cottontail_fire"
  | "gun_jackrabbit_fire"
  | "gun_broadfork_fire"
  | "gun_hedgerow_fire"
  | "gun_seeddrill_fire"
  | "gun_pump"
  | "gun_shell_in"
  | "gun_mag_out"
  | "gun_mag_in"
  | "gun_slide"
  | "gun_bolt"
  | "gun_pod_out"
  | "gun_pod_in"
  | "gun_dry"
  | "gun_pickup"
  | "gun_mode"
  | "gun_cottontail_silenced"
  | "gun_silencer_twist"
  | "gun_silencer_seat"
  | "gun_silencer_crack"
  | "gun_silencer_off";

export interface SfxDef {
  bus: BusId;
  /** Mix level (files are peak-normalised, so this is the only level control). */
  gain: number;
  /** Simultaneous voices of this id; the oldest is stolen beyond it. */
  max: number;
  /** Random pitch spread (± fraction of playback rate). */
  jitter: number;
  /** Minimum seconds between two starts (debounce), 0 = none. */
  gap?: number;
  /** Another sound started with this one (same gain / rate scaling), e.g. the landing under the confirm chime. */
  layer?: SfxId;
}

const d = (bus: BusId, gain: number, max: number, jitter = 0, gap = 0): SfxDef => ({ bus, gain, max, jitter, gap });

export const SFX: Record<SfxId, SfxDef> = {
  jump: d("sfx", 0.3, 2, 0.06, 0.05),
  land_soft: d("sfx", 0.45, 2, 0.06, 0.05),
  land_hard: d("sfx", 0.85, 2, 0.05, 0.1),
  step_concrete: d("sfx", 0.4, 3, 0.07),
  step_metal: d("sfx", 0.4, 3, 0.07),
  step_wood: d("sfx", 0.42, 3, 0.07),
  step_grass: d("sfx", 0.42, 3, 0.07),
  step_tile: d("sfx", 0.4, 3, 0.07),
  step_water: d("sfx", 0.45, 3, 0.07),
  wind: d("ambience", 0.9, 1),
  wind_high: d("ambience", 0.6, 1),
  teleport: d("sfx", 0.55, 2, 0.04, 0.15),
  boost: d("sfx", 0.7, 2, 0.04, 0.2),
  water_enter: d("sfx", 0.7, 2, 0.05, 0.3),
  water_exit: d("sfx", 0.5, 1, 0.05, 0.4),
  swim: d("sfx", 0.45, 2, 0.08),
  announcer_perfect: d("sfx", 0.85, 1),
  announcer_godlike: d("sfx", 0.85, 1),
  announcer_holyshit: d("sfx", 0.85, 1),
  start_beep: d("sfx", 0.5, 1, 0, 0.1),
  split: d("sfx", 0.55, 2, 0),
  finish: d("sfx", 0.7, 1, 0),
  finish_pb: d("sfx", 0.8, 1, 0),
  finish_wr: d("sfx", 0.85, 1, 0),
  rank_up: d("ui", 0.75, 1, 0, 1),
  achievement: d("ui", 0.75, 1, 0, 1),
  level_up: d("ui", 0.75, 1, 0, 1),
  // UI "Foley" kit (tools/audio/foley.ts): slices of the game's own sounds, so the menus sound like the bunny moving.
  // Levels below are matched on the loudest 20 ms RMS (file level + gain): -17 to -26 dB, the old ui_* range.
  // ui_hover: tile footstep tap, pitched per row by audio/ui.ts (+2.5% a row), so almost no random jitter.
  ui_hover: d("ui", 0.6, 2, 0.005, 0.035),
  ui_click: d("ui", 0.4, 2, 0.02, 0.03),
  // The two-tone chime with the soft landing 8 dB under it: you "land" on Play.
  ui_confirm: { ...d("ui", 0.45, 1, 0, 0.05), layer: "ui_land" },
  // The same landing at 0.85 rate (baked), no chime.
  ui_back: d("ui", 0.44, 1, 0.02, 0.05),
  // Generated switch flick; still the sniper zoom click in game (viewmodel/weapons.ts). Menus use ui_switch.
  ui_toggle: d("ui", 0.4, 2, 0.02, 0.03),
  // Empty-gun click.
  ui_error: d("ui", 0.7, 1, 0.02, 0.3),
  ui_card: d("ui", 0.4, 2, 0.02, 0.05),
  // Jump "hup" attack, on pointerdown.
  ui_press: d("ui", 0.43, 2, 0.03, 0.03),
  ui_land: d("ui", 0.28, 1, 0.02, 0.05),
  // Gun fire-mode click; toggleSound() pitches it up for on, down for off.
  ui_switch: d("ui", 0.65, 2, 0.01, 0.03),
  // 180 ms band-passed wind puff for screens opening; ui_close is it reversed.
  ui_open: d("ui", 0.17, 1, 0.03, 0.12),
  ui_close: d("ui", 0.17, 1, 0.03, 0.12),
  countdown_tick: d("ui", 0.5, 1, 0),
  countdown_go: d("ui", 0.6, 1, 0),
  // Notification accents: quiet (around footstep level, under chat / clicks and well under the fanfares they sit with).
  toast_pop: d("ui", 0.22, 1, 0.04, 0.15),
  // Pitched per step by the caller (+6% a tick, notify/timing.ts TickPacer), so barely any random jitter on top.
  count_tick: d("ui", 0.14, 2, 0.01, 0.05),
  stamp: d("ui", 0.35, 1, 0.04, 0.1),
  bunny_boing: d("ui", 0.14, 1, 0.05, 0.3),
  shine: d("ui", 0.18, 1, 0.03, 0.5),
  chat: d("ui", 0.35, 2, 0, 0.12),
  supporter_gift: d("ui", 0.6, 2, 0, 0),
  player_join: d("ui", 0.4, 1, 0, 0.5),
  vote_open: d("ui", 0.55, 1, 0, 1),
  vote_tick: d("ui", 0.3, 2, 0.03, 0.08),
  map_change: d("ui", 0.6, 1, 0, 1),
  carrot_swing: d("sfx", 0.45, 2, 0.06, 0.04),
  carrot_stab: d("sfx", 0.55, 2, 0.05, 0.04),
  carrot_draw: d("sfx", 0.4, 1, 0.03, 0.1),
  // Played at the hit point (positional). The stab plays them louder and lower, bullets a little higher.
  impact_metal: d("sfx", 0.5, 3, 0.06),
  impact_wood: d("sfx", 0.55, 3, 0.06),
  impact_concrete: d("sfx", 0.5, 3, 0.06),
  impact_dirt: d("sfx", 0.55, 3, 0.06),
  impact_tile: d("sfx", 0.45, 3, 0.06),
  shot_pistol: d("sfx", 0.55, 3, 0.04),
  shot_sniper: d("sfx", 0.7, 2, 0.03),
  gun_draw: d("sfx", 0.4, 1, 0.03, 0.1),
  // Our guns (viewmodel/guns/sounds.ts): fire under the impacts' peak level so a spray doesn't dominate the mix; the Seed
  // Drill fires 14 a second, so it is quieter, shorter and allows more overlapping voices.
  gun_thumper_fire: d("sfx", 0.5, 4, 0.04),
  gun_cottontail_fire: d("sfx", 0.5, 3, 0.04),
  gun_jackrabbit_fire: d("sfx", 0.58, 3, 0.03),
  gun_broadfork_fire: d("sfx", 0.62, 2, 0.03),
  gun_hedgerow_fire: d("sfx", 0.58, 3, 0.03),
  gun_seeddrill_fire: d("sfx", 0.36, 5, 0.05),
  gun_pump: d("sfx", 0.45, 1, 0.03, 0.1),
  gun_shell_in: d("sfx", 0.42, 2, 0.05, 0.05),
  gun_mag_out: d("sfx", 0.4, 1, 0.03, 0.1),
  gun_mag_in: d("sfx", 0.45, 1, 0.03, 0.1),
  gun_slide: d("sfx", 0.42, 1, 0.03, 0.08),
  gun_bolt: d("sfx", 0.42, 1, 0.03, 0.08),
  gun_pod_out: d("sfx", 0.4, 1, 0.03, 0.1),
  gun_pod_in: d("sfx", 0.45, 1, 0.03, 0.1),
  gun_dry: d("sfx", 0.4, 2, 0.04, 0.06),
  gun_pickup: d("sfx", 0.45, 1, 0.03, 0.2),
  gun_mode: d("sfx", 0.35, 1, 0.02, 0.05),
  gun_cottontail_silenced: d("sfx", 0.34, 3, 0.04),
  gun_silencer_twist: d("sfx", 0.32, 2, 0.07, 0.05),
  gun_silencer_seat: d("sfx", 0.42, 1, 0.03, 0.08),
  gun_silencer_crack: d("sfx", 0.42, 1, 0.03, 0.08),
  gun_silencer_off: d("sfx", 0.38, 1, 0.03, 0.08),
};

export const SFX_IDS = Object.keys(SFX) as SfxId[];

/** Walkable surface classes (footsteps). */
export type Surface = "concrete" | "metal" | "wood" | "grass" | "tile" | "water";
export const SURFACES: Surface[] = ["concrete", "metal", "wood", "grass", "tile", "water"];
export const STEP_SFX: Record<Surface, SfxId> = {
  concrete: "step_concrete",
  metal: "step_metal",
  wood: "step_wood",
  grass: "step_grass",
  tile: "step_tile",
  water: "step_water",
};
