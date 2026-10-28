// Settings → Audio, registered through the settings registry (ui/settings-registry.ts) with the shared controls
// (ui/controls.ts). Two columns of groups: levels + channel mutes on the left, music and sound options on the right.

import { registerSettingsSection } from "../ui/settings-registry";
import { DEFAULT_PREFS, keyLabel, prefs, type MusicMode, type AnnouncerLine, type Prefs } from "../ui/settings";
import { h } from "../ui/dom";
import { announce, announcerAvailable, classic, engine, music, nextTrack, sfx } from "./index";
import { trackName } from "./now-playing";
import type { SfxId } from "./catalog";

type BusKey = "music" | "sfx" | "ui" | "ambience";

const P = () => prefs.get();
const up = (fn: (p: Prefs) => void) => prefs.update(fn);
const keyOf = (a: "mute" | "nextTrack") => {
  const c = P().binds[a]?.[0];
  return c ? keyLabel(c) : "unbound";
};

/** Registers the Audio category (call once at startup). */
export function registerAudioSettings(): void {
  registerSettingsSection(
    "audio",
    (ui) => {
      const pct = { min: 0, max: 1, step: 0.05, scale: 100, unit: "%" } as const;
      // Dragging a muted channel's slider unmutes it; a test sound plays when you let go.
      const level = (k: BusKey, label: string, desc: string, test?: SfxId) => {
        const r = ui.range(
          label,
          () => P().audio[k],
          (v) =>
            up((p) => {
              p.audio[k] = v;
              p.audio.mute[k] = false;
            }),
          { ...pct, desc, keywords: `volume sound audio loud quiet ${label.toLowerCase()}` },
        );
        if (test) r.querySelector("input[type=range]")?.addEventListener("change", () => sfx(test));
        return r;
      };
      const mute = (k: BusKey, label: string) => ui.check(label, () => P().audio.mute[k], (v) => up((p) => (p.audio.mute[k] = v)), { desc: `Silence ${label.toLowerCase()} only.`, keywords: `mute silence ${label.toLowerCase()}` });
      const playing = h("small.set-readout");
      const paint = () => {
        const t = music.current;
        playing.textContent = !engine.unlocked ? "starts after your first click or key press" : t ? `now playing: ${trackName(t)}` : "";
      };
      paint();
      const poll = window.setInterval(() => (playing.isConnected ? paint() : clearInterval(poll)), 1000);
      const test = (label: string, ids: SfxId[]) => ui.button(label, () => ids.forEach((id, i) => window.setTimeout(() => sfx(id), i * 320)));
      return {
        columns: [
          [
            ui.group(
              "Volume",
              ui.range("Master volume", () => P().volume, (v) => up((p) => (p.volume = v)), { ...pct, hint: "Everything the game plays", desc: "The channels below are a share of this.", keywords: "sound audio volume loud quiet" }),
              ui.toggle("Mute all", () => P().audio.muted, (v) => up((p) => (p.audio.muted = v)), { hint: `${keyOf("mute")} mutes anywhere`, desc: `${keyOf("mute")} mutes / unmutes anywhere (rebind in Keys); the speaker button in the menus does too.`, keywords: "sound off silence mute" }),
              level("music", "Music", "The soundtrack in menus and in game."),
              level("sfx", "Effects", "Jumps, landings, footsteps, run chimes, other players.", "land_soft"),
              level("ambience", "Wind & water", "Wind that rises with your speed, and water.", undefined),
              level("ui", "Interface", "Menus, chat, votes, level ups.", "ui_click"),
            ),
          ],
          [
            ui.group(
              "Music",
              ui.segmented<MusicMode>("Play music", () => P().audio.musicMode, (v) => up((p) => (p.audio.musicMode = v)), [
                ["always", "Always"],
                ["menus", "Only in menus"],
                ["off", "Off"],
              ], { desc: "Always: every track in menus, the game tracks in game. Only in menus: home screen and pause menu.", keywords: "music songs soundtrack playlist off" }),
              ui.toggle("Shuffle", () => P().audio.shuffle, (v) => up((p) => (p.audio.shuffle = v)), { desc: "Shuffle the order of the tracks.", keywords: "music random playlist rotation" }),
              ui.row("Next track", h("div.btn-row", null, ui.button("Skip ▸", () => (nextTrack(), window.setTimeout(paint, 60)))), {
                desc: `${keyOf("nextTrack")} skips anywhere; media keys work too. Tracks crossfade; the music dips under announcements.`,
                readout: playing,
                keywords: "music skip song next track",
              }),
            ),
            ui.group(
              "Sounds",
              ui.toggle("Footsteps", () => P().audio.footsteps, (v) => up((p) => (p.audio.footsteps = v)), { desc: "Running on the ground; the sound follows the surface (concrete, metal, wood, grass, tile, water).", keywords: "steps walking surface" }),
              ui.toggle("Wind", () => P().audio.wind, (v) => up((p) => (p.audio.wind = v)), { desc: "Rushing wind that rises with your speed.", keywords: "wind speed rush" }),
              ui.toggle("Other players", () => P().audio.others, (v) => up((p) => (p.audio.others = v)), { desc: "Positional jumps, landings and footsteps of players in your room.", keywords: "players multiplayer others room" }),
              ui.toggle("Classic CS:S sounds", () => P().audio.classic, (v) => up((p) => (p.audio.classic = v)), {
                desc: () =>
                  classic.available
                    ? "Original CS:S footsteps, landings, water and knife sounds from the hosted CS:S content (the carrot uses the knife)."
                    : "Original CS:S footsteps, landings, water and knife sounds. Needs the hosted CS:S content, which isn't available here yet: our own sounds play until it is.",
                keywords: "counter-strike source valve",
              }),
            ),
          ],
        ],
        advanced: [
          ui.group(
            "Scroll feedback",
            ui.toggle("Perf% HUD", () => P().audio.perfHud, v => up(p => p.audio.perfHud = v), { desc: "Timer-measured perfect hops beside Sync% in Legit Scroll and EZ Scroll. — until an eligible hop.", keywords: "perf perfect scroll sync hud" }),
            ui.toggle("Perfect hop indicator", () => P().audio.perfectIndicator, v => up(p => p.audio.perfectIndicator = v), { desc: "Brief Perfect text after an eligible one-tick landing hop.", keywords: "perf landing scroll text" }),
            ui.toggle("Quiet perfect hop tick", () => P().audio.perfectTick, v => up(p => p.audio.perfectTick = v), { desc: "A quiet immediate tick, independent of announcer voices.", keywords: "perf landing scroll audio cue" }),
          ),
          ui.group(
            "Announcer",
            ui.toggle("Enable announcer", () => P().audio.announcer.enabled, v => up(p => p.audio.announcer.enabled = v), { desc: () => announcerAvailable("perfect") && announcerAvailable("godlike") && announcerAvailable("holyshit") ? "Classic arena voice cues. Off by default." : "Voice samples are not installed in this build. Settings are saved; previews require the approved sound pack.", keywords: "quake unreal tournament godlike holy shit perfect announcer" }),
            ...([ ["finish", "Verified finishes"], ["movement", "Movement milestones"], ["local", "Your announcements"], ["server", "Room world records"] ] as const).map(([key, label]) => ui.toggle(label, () => P().audio.announcer[key], v => up(p => p.audio.announcer[key] = v), { keywords: "announcer voice sound" })),
            ui.range("Announcer volume", () => P().audio.announcer.volume, v => up(p => p.audio.announcer.volume = v), { ...pct, keywords: "announcer voice volume" }),
            ...([ ["pb", "Verified PB"], ["wr", "Verified WR"], ["speed", "Speed milestone"], ["highSpeed", "High speed milestone"], ["streak", "Perfect hop streak"] ] as const).map(([key, label]) => ui.segmented<AnnouncerLine>(label, () => P().audio.announcer[key], v => up(p => p.audio.announcer[key] = v), [["off", "Off"], ["perfect", "Perfect"], ["godlike", "Godlike"], ["holyshit", "Holy shit"]], { keywords: "announcer voice trigger" })),
            ui.range("Speed threshold", () => P().audio.announcer.speedThreshold, v => up(p => p.audio.announcer.speedThreshold = v), { min: 500, max: 10000, step: 100, unit: " u/s", keywords: "announcer speed milestone" }),
            ui.range("High speed threshold", () => P().audio.announcer.highSpeedThreshold, v => up(p => p.audio.announcer.highSpeedThreshold = v), { min: 500, max: 10000, step: 100, unit: " u/s", keywords: "announcer speed milestone" }),
            ui.range("Perfect streak length", () => P().audio.announcer.streakThreshold, v => up(p => p.audio.announcer.streakThreshold = v), { min: 2, max: 20, step: 1, keywords: "announcer perfect streak hops" }),
            ui.segmented<AnnouncerLine>("Longjump voice", () => P().audio.announcer.lj, v => up(p => p.audio.announcer.lj = v), [["off", "Off"], ["perfect", "Perfect"], ["godlike", "Godlike"], ["holyshit", "Holy shit"]], { desc: "Local clean LJs only, with Longjump stats enabled in HUD. Uses the announcer's volume, movement and your announcements switches.", keywords: "lj longjump announcer hera" }),
            ui.range("Longjump distance", () => P().audio.announcer.ljThreshold, v => up(p => p.audio.announcer.ljThreshold = v), { min: 200, max: 1000, step: 1, unit: " units", desc: "Minimum clean LJ distance for a voice cue. Bhop jumps do not trigger it.", keywords: "lj longjump announcer threshold" }),
            ui.actions("Preview voices", [ui.button("Perfect", () => announce("pb", undefined, false, "perfect")), ui.button("Godlike", () => announce("wr", undefined, false, "godlike")), ui.button("Holy shit", () => announce("highSpeed", undefined, false, "holyshit"))], { keywords: "announcer sample test preview" }),
          ),
          ui.group("Mute channels", mute("music", "Music"), mute("sfx", "Effects"), mute("ambience", "Wind & water"), mute("ui", "Interface")),
          ui.group(
            "More",
            ui.toggle("Ghost sounds", () => P().audio.ghosts, (v) => up((p) => (p.audio.ghosts = v)), { desc: "Quiet positional sounds for race ghosts.", keywords: "ghost ghosts" }),
            ui.toggle("Mute in background", () => P().audio.muteInBackground, (v) => up((p) => (p.audio.muteInBackground = v)), { desc: "Silence while the tab is hidden.", keywords: "background tab alt-tab hidden mute" }),
            ui.actions("Test", [test("Jump", ["jump", "land_soft"]), test("Drop", ["land_hard"]), test("Split", ["split"]), test("PB", ["finish_pb"])], { hint: "At the current levels", keywords: "test preview listen sound" }),
          ),
        ],
      };
    },
    {
      label: "Audio",
      blurb: "",
      icon: "audio",
      order: 70,
      reset: () =>
        prefs.update((p) => {
          p.volume = DEFAULT_PREFS.volume;
          p.audio = JSON.parse(JSON.stringify(DEFAULT_PREFS.audio));
        }),
    },
  );
}
